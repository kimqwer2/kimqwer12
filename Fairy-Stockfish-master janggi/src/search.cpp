/*
  Stockfish, a UCI chess playing engine derived from Glaurung 2.1
  Copyright (C) 2004-2022 The Stockfish developers (see AUTHORS file)

  Stockfish is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Stockfish is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

#include "search.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <sstream>

#include "evaluate.h"
#include "misc.h"
#include "movegen.h"
#include "movepick.h"
#include "partner.h"
#include "position.h"
#include "thread.h"
#include "timeman.h"
#include "tt.h"
#include "uci.h"
#include "xboard.h"
#include "syzygy/tbprobe.h"

namespace Stockfish {

namespace Search {
  LimitsType Limits;
}

namespace Tablebases {
  int Cardinality;
  bool RootInTB;
  bool UseRule50;
  Depth ProbeDepth;
}

namespace TB = Tablebases;

using std::string;
using Eval::evaluate;
using namespace Search;

namespace {

enum NodeType { NonPV, PV, Root };

constexpr uint64_t TtHitAverageWindow     = 4096;
constexpr uint64_t TtHitAverageResolution = 1024;

Value futility_margin(Depth d, bool improving) {
    return Value(214 * (d - improving));
}

int Reductions[MAX_MOVES];

Depth reduction(bool i, Depth d, int mn) {
    int r = Reductions[d] * Reductions[mn];
    return (r + 534) / 1024 + (!i && r > 904);
}

int futility_move_count(bool improving, Depth depth, const Position& pos) {
    return (3 + depth * depth * (1 + pos.walling()) + 2 * pos.blast_on_capture()) / (2 - improving + pos.blast_on_capture());
}

int stat_bonus(Depth d) {
    return d > 14 ? 73 : 6 * d * d + 229 * d - 215;
}

Value value_draw(Thread* thisThread) {
    return VALUE_DRAW + Value(2 * (thisThread->nodes & 1) - 1);
}

struct Skill {
    explicit Skill(int l) : level(l) {}
    bool enabled() const { return level < 20; }
    bool time_to_pick(Depth depth) const { return depth == 1 + std::max(level, 0); }
    Move pick_best(size_t multiPV);

    int level;
    Move best = MOVE_NONE;
};

template <NodeType nodeType>
Value search(Position& pos, Stack* ss, Value alpha, Value beta, Depth depth, bool cutNode);

template <NodeType nodeType>
Value qsearch(Position& pos, Stack* ss, Value alpha, Value beta, Depth depth = 0);

Value value_to_tt(Value v, int ply);
Value value_from_tt(Value v, int ply, int r50c);
void update_pv(Move* pv, Move move, Move* childPv);
void update_continuation_histories(Stack* ss, Piece pc, Square to, int bonus);
void update_quiet_stats(const Position& pos, Stack* ss, Move move, int bonus, int depth);
void update_all_stats(const Position& pos, Stack* ss, Move bestMove, Value bestValue, Value beta, Square prevSq,
                      Move* quietsSearched, int quietCount, Move* capturesSearched, int captureCount, Depth depth);

template<bool Root>
uint64_t perft(Position& pos, Depth depth) {
    StateInfo st;
    ASSERT_ALIGNED(&st, Eval::NNUE::CacheLineSize);
    uint64_t cnt, nodes = 0;
    const bool leaf = (depth == 2);

    for (const auto& m : MoveList<LEGAL>(pos))
    {
        assert(pos.pseudo_legal(m));
        if (Root && depth <= 1)
            cnt = 1, nodes++;
        else
        {
            pos.do_move(m, st);
            cnt = leaf ? MoveList<LEGAL>(pos).size() : perft<false>(pos, depth - 1);
            nodes += cnt;
            pos.undo_move(m);
        }
        if (Root)
            sync_cout << UCI::move(pos, m) << ": " << cnt << sync_endl;
    }
    return nodes;
}

} // namespace

void Search::init() {
    for (int i = 1; i < MAX_MOVES; ++i)
        Reductions[i] = int(21.9 * std::log(i));
}

void Search::clear() {
    Threads.main()->wait_for_search_finished();
    Time.availableNodes = 0;
    TT.clear();
    Threads.clear();
    Tablebases::init(Options["SyzygyPath"]);
}

void MainThread::search() {
    if (Limits.perft)
    {
        nodes = perft<true>(rootPos, Limits.perft);
        sync_cout << "\nNodes searched: " << nodes << "\n" << sync_endl;
        return;
    }

    Color us = rootPos.side_to_move();
    Time.init(rootPos, Limits, us, rootPos.game_ply());
    TT.new_search();
    Eval::NNUE::verify();

    if (rootMoves.empty() || (CurrentProtocol == XBOARD && rootPos.is_optional_game_end()))
    {
        rootMoves.emplace_back(MOVE_NONE);
        Value variantResult;
        Value result = rootPos.is_game_end(variantResult) ? variantResult
                     : rootPos.checkers()                 ? rootPos.checkmate_value()
                                                          : rootPos.stalemate_value();
        if (CurrentProtocol == XBOARD)
        {
            std::rotate(rootMoves.rbegin(), rootMoves.rbegin() + 1, rootMoves.rend());
            if (!ponder)
                sync_cout << (result == VALUE_DRAW ? "1/2-1/2 {Draw}"
                              : (rootPos.side_to_move() == BLACK ? -result : result) == VALUE_MATE ? "1-0 {White wins}"
                              : "0-1 {Black wins}") << sync_endl;
        }
        else
            sync_cout << "info depth 0 score " << UCI::value(result) << sync_endl;
    }
    else
    {
        Threads.start_searching();
        Thread::search();
    }

    if (rootPos.two_boards() && !Threads.abort && CurrentProtocol == XBOARD)
    {
        while (!Threads.stop && (Partner.sitRequested || (Partner.weDead && !Partner.partnerDead)) && Time.elapsed() < Limits.time[us] - 1000)
        {}
    }

    while (!Threads.stop && (ponder || Limits.infinite)) {}
    Threads.stop = true;
    Threads.wait_for_search_finished();

    if (Limits.npmsec)
        Time.availableNodes += Limits.inc[us] - Threads.nodes_searched();

    bestThread = this;
    int skillLevel = int(Options["Skill Level"]);
    if (int(Options["MultiPV"]) == 1 && !Limits.depth
        && !(Skill(skillLevel).enabled() || int(Options["UCI_LimitStrength"]))
        && rootMoves[0].pv[0] != MOVE_NONE)
        bestThread = Threads.get_best_thread();

    bestPreviousScore = bestThread->rootMoves[0].score;

    if (bestThread != this)
        sync_cout << UCI::pv(bestThread->rootPos, bestThread->completedDepth, -VALUE_INFINITE, VALUE_INFINITE) << sync_endl;

    if (CurrentProtocol == XBOARD)
    {
        Move bestMove = bestThread->rootMoves[0].pv[0];
        if (rootPos.two_boards() && rootPos.virtual_drop(bestMove))
        {
            Partner.ptell("fast");
            while (!Threads.abort && !Partner.partnerDead && !Partner.fast && Limits.time[us] - Time.elapsed() > Partner.opptime)
            {}
            Partner.ptell("x");
            for (const auto& m : this->rootMoves)
                if (!rootPos.virtual_drop(m.pv[0]))
                {
                    bestMove = m.pv[0];
                    break;
                }
        }
        if (!Limits.infinite && !ponder && rootMoves[0].pv[0] != MOVE_NONE && !Threads.abort.exchange(true))
        {
            std::string move = UCI::move(rootPos, bestMove);
            if (rootPos.walling())
            {
                sync_cout << "move " << move.substr(0, move.find(",")) << "," << sync_endl;
                sync_cout << "move " << move.substr(move.find(",") + 1) << sync_endl;
            }
            else
                sync_cout << "move " << UCI::move(rootPos, bestMove) << sync_endl;

            // XBOARD 상태 머신에 착수 반영 (불법수 몰수패 방지 핵심)
            if (XBoard::stateMachine && XBoard::stateMachine->moveAfterSearch)
            {
                XBoard::stateMachine->do_move(bestMove);
                XBoard::stateMachine->moveAfterSearch = false;
                if (Options["Ponder"] && (bestThread->rootMoves[0].pv.size() > 1
                                          || bestThread->rootMoves[0].extract_ponder_from_tt(rootPos)))
                    XBoard::stateMachine->ponderMove = bestThread->rootMoves[0].pv[1];
            }
        }
        return;
    }

    sync_cout << "bestmove " << UCI::move(rootPos, bestThread->rootMoves[0].pv[0]);
    if (bestThread->rootMoves[0].pv.size() > 1 || bestThread->rootMoves[0].extract_ponder_from_tt(rootPos))
        std::cout << " ponder " << UCI::move(rootPos, bestThread->rootMoves[0].pv[1]);
    std::cout << sync_endl;
}

void Thread::search() {
    Stack stack[MAX_PLY + 10], *ss = stack + 7;
    Move pv[MAX_PLY + 1];
    Value bestValue, alpha, beta, delta;
    Move lastBestMove = MOVE_NONE;
    Depth lastBestMoveDepth = 0;
    MainThread* mainThread = (this == Threads.main() ? Threads.main() : nullptr);
    double timeReduction = 1, totBestMoveChanges = 0;
    Color us = rootPos.side_to_move();
    int iterIdx = 0;

    std::memset(ss - 7, 0, 10 * sizeof(Stack));
    for (int i = 7; i > 0; i--)
        (ss - i)->continuationHistory = &this->continuationHistory[0][0][NO_PIECE][0];

    for (int i = 0; i <= MAX_PLY + 2; ++i)
        (ss + i)->ply = i;

    ss->pv = pv;
    bestValue = delta = alpha = -VALUE_INFINITE;
    beta = VALUE_INFINITE;

    if (mainThread)
    {
        if (mainThread->bestPreviousScore == VALUE_INFINITE)
            for (int i = 0; i < 4; ++i)
                mainThread->iterValue[i] = VALUE_ZERO;
        else
            for (int i = 0; i < 4; ++i)
                mainThread->iterValue[i] = mainThread->bestPreviousScore;
    }

    lowPlyHistory.fill(0);
    size_t multiPV = size_t(Options["MultiPV"]);

    PRNG rng(now());
    double shiftedElo = Options["UCI_Elo"] - 1346.6;
    double floatLevel = Options["UCI_LimitStrength"] ?
                        std::clamp(shiftedElo > 0 ? std::pow(shiftedElo / 143.4, 1 / 0.806)
                                                  : shiftedElo / 143.4 + std::pow(shiftedElo / 500, 5),
                                   -20.0, 20.0) :
                          double(Options["Skill Level"]);
    int intLevel = int(floatLevel) +
                   ((floatLevel - int(floatLevel)) * 1024 > rng.rand<unsigned>() % 1024 ? 1 : 0);
    Skill skill(intLevel);

    if (skill.enabled())
        multiPV = std::max(multiPV, (size_t)4);

    multiPV = std::min(multiPV, rootMoves.size());
    ttHitAverage = TtHitAverageWindow * TtHitAverageResolution / 2;
    trend = SCORE_ZERO;
    int searchAgainCounter = 0;

    while (++rootDepth < MAX_PLY && !Threads.stop
           && !(Limits.depth && mainThread && rootDepth > Limits.depth))
    {
        if (mainThread)
            totBestMoveChanges /= 2;

        for (RootMove& rm : rootMoves)
            rm.previousScore = rm.score;

        size_t pvFirst = 0;
        pvLast = 0;

        if (!Threads.increaseDepth)
            searchAgainCounter++;

        for (pvIdx = 0; pvIdx < multiPV && !Threads.stop; ++pvIdx)
        {
            if (pvIdx == pvLast)
            {
                pvFirst = pvLast;
                for (pvLast++; pvLast < rootMoves.size(); pvLast++)
                    if (rootMoves[pvLast].tbRank != rootMoves[pvFirst].tbRank)
                        break;
            }

            selDepth = 0;

            if (rootDepth >= 4)
            {
                Value prev = rootMoves[pvIdx].previousScore;
                delta = Value(17 * (1 + rootPos.captures_to_hand()));
                alpha = std::max(prev - delta, -VALUE_INFINITE);
                beta = std::min(prev + delta, VALUE_INFINITE);

                int tr = 113 * prev / (abs(prev) + 147);
                trend = (us == WHITE ? make_score(tr, tr / 2) : -make_score(tr, tr / 2));
            }
            else
            {
                alpha = -VALUE_INFINITE;
                beta  = VALUE_INFINITE;
            }

            int failedHighCnt = 0;
            while (true)
            {
                Depth adjustedDepth = std::max(1, rootDepth - failedHighCnt - searchAgainCounter);
                bestValue = Stockfish::search<Root>(rootPos, ss, alpha, beta, adjustedDepth, false);

                std::stable_sort(rootMoves.begin() + pvIdx, rootMoves.begin() + pvLast);

                if (Threads.stop)
                    break;

                if (bestValue <= alpha)
                {
                    beta = (alpha + beta) / 2;
                    alpha = std::max(bestValue - delta, -VALUE_INFINITE);
                    failedHighCnt = 0;
                    if (mainThread)
                        mainThread->stopOnPonderhit = false;
                }
                else if (bestValue >= beta)
                {
                    beta = std::min(bestValue + delta, VALUE_INFINITE);
                    ++failedHighCnt;
                }
                else
                    break;

                delta += delta / 4 + 5;
                assert(alpha >= -VALUE_INFINITE && beta <= VALUE_INFINITE);
            }

            std::stable_sort(rootMoves.begin() + pvFirst, rootMoves.begin() + pvIdx + 1);

            if (mainThread && (Threads.stop || pvIdx + 1 == multiPV || Time.elapsed() > 3000))
                sync_cout << UCI::pv(rootPos, rootDepth, alpha, beta) << sync_endl;
        }

        if (!Threads.stop)
            completedDepth = rootDepth;

        if (rootMoves[0].pv[0] != lastBestMove)
        {
            lastBestMove = rootMoves[0].pv[0];
            lastBestMoveDepth = rootDepth;
        }

        if (Limits.mate && bestValue >= VALUE_MATE_IN_MAX_PLY && VALUE_MATE - bestValue <= 2 * Limits.mate)
            Threads.stop = true;

        if (!mainThread)
            continue;

        if (skill.enabled() && skill.time_to_pick(rootDepth))
            skill.pick_best(multiPV);

        if (Limits.use_time_management() && !Threads.stop && !mainThread->stopOnPonderhit)
        {
            double fallingEval = (318 + 6 * (mainThread->bestPreviousScore - bestValue)
                                      + 6 * (mainThread->iterValue[iterIdx] - bestValue)) / 825.0;
            fallingEval = std::clamp(fallingEval, 0.5, 1.5);
            timeReduction = lastBestMoveDepth + 9 < completedDepth ? 1.92 : 0.95;
            double reductionFactor = (1.47 + mainThread->previousTimeReduction) / (2.32 * timeReduction);

            for (Thread* th : Threads)
            {
                totBestMoveChanges += th->bestMoveChanges;
                th->bestMoveChanges = 0;
            }
            double bestMoveInstability = 1.073 + std::max(1.0, 2.25 - 9.9 / rootDepth)
                                                * totBestMoveChanges / Threads.size();
            double totalTime = Time.optimum() * fallingEval * reductionFactor * bestMoveInstability;

            if (rootMoves.size() == 1)
                totalTime = std::min(500.0, totalTime);

            if (Time.elapsed() > totalTime)
            {
                if (mainThread->ponder)
                    mainThread->stopOnPonderhit = true;
                else
                    Threads.stop = true;
            }
            else
                Threads.increaseDepth = (Time.elapsed() <= totalTime * 0.58);
        }

        mainThread->iterValue[iterIdx] = bestValue;
        iterIdx = (iterIdx + 1) & 3;
    }

    if (!mainThread)
        return;

    mainThread->previousTimeReduction = timeReduction;

    if (skill.enabled())
        std::swap(rootMoves[0], *std::find(rootMoves.begin(), rootMoves.end(),
                  skill.best ? skill.best : skill.pick_best(multiPV)));
}

namespace {

template <NodeType nodeType>
Value search(Position& pos, Stack* ss, Value alpha, Value beta, Depth depth, bool cutNode) {
    constexpr bool PvNode = (nodeType != NonPV);
    constexpr bool rootNode = (nodeType == Root);
    const Depth maxNextDepth = rootNode ? depth : depth + 1;

    if (!rootNode && pos.rule50_count() >= 3 && alpha < VALUE_DRAW && pos.has_game_cycle(ss->ply))
    {
        alpha = value_draw(pos.this_thread());
        if (alpha >= beta)
            return alpha;
    }

    if (depth <= 0)
        return qsearch<PvNode ? PV : NonPV>(pos, ss, alpha, beta);

    assert(-VALUE_INFINITE <= alpha && alpha < beta && beta <= VALUE_INFINITE);
    assert(PvNode || (alpha == beta - 1));
    assert(0 < depth && depth < MAX_PLY);

    Move pv[MAX_PLY + 1], capturesSearched[32], quietsSearched[64];
    StateInfo st;
    ASSERT_ALIGNED(&st, Eval::NNUE::CacheLineSize);

    TTEntry* tte;
    Key posKey;
    Move ttMove, move, excludedMove, bestMove;
    Depth extension, newDepth;
    Value bestValue, value, ttValue, eval, maxValue, probCutBeta;
    bool givesCheck, improving, didLMR, priorCapture;
    bool captureOrPromotion, doFullDepthSearch, moveCountPruning, ttCapture, singularQuietLMR;
    Piece movedPiece;
    int moveCount = 0, captureCount = 0, quietCount = 0;

    Thread* thisThread = pos.this_thread();
    ss->inCheck = pos.checkers();
    priorCapture = pos.captured_piece();
    Color us = pos.side_to_move();
    bestValue = -VALUE_INFINITE;
    maxValue = VALUE_INFINITE;

    if (thisThread == Threads.main())
        static_cast<MainThread*>(thisThread)->check_time();

    if (PvNode && thisThread->selDepth < ss->ply + 1)
        thisThread->selDepth = ss->ply + 1;

    if (!rootNode)
    {
        Value variantResult;
        if (pos.is_game_end(variantResult, ss->ply))
            return variantResult;

        if (Threads.stop.load(std::memory_order_relaxed) || ss->ply >= MAX_PLY)
            return (ss->ply >= MAX_PLY && !ss->inCheck) ? evaluate(pos) : value_draw(pos.this_thread());

        alpha = std::max(mated_in(ss->ply), alpha);
        beta  = std::min(mate_in(ss->ply + 1), beta);
        if (alpha >= beta)
            return alpha;
    }

    assert(0 <= ss->ply && ss->ply < MAX_PLY);

    (ss + 1)->ttPv = false;
    (ss + 1)->excludedMove = bestMove = MOVE_NONE;
    (ss + 2)->killers[0] = (ss + 2)->killers[1] = MOVE_NONE;
    ss->doubleExtensions = (ss - 1)->doubleExtensions;
    Square prevSq = to_sq((ss - 1)->currentMove);

    if (!rootNode)
        (ss + 2)->statScore = 0;

    excludedMove = ss->excludedMove;
    posKey = (excludedMove == MOVE_NONE ? pos.key() : pos.key() ^ make_key(excludedMove));
    tte = TT.probe(posKey, ss->ttHit);
    ttValue = ss->ttHit ? value_from_tt(tte->value(), ss->ply, pos.rule50_count()) : VALUE_NONE;
    ttMove = rootNode ? thisThread->rootMoves[thisThread->pvIdx].pv[0] : ss->ttHit ? tte->move() : MOVE_NONE;
    if (!excludedMove)
        ss->ttPv = PvNode || (ss->ttHit && tte->is_pv());

    if (ss->ttPv && depth > 12 && ss->ply - 1 < MAX_LPH && !priorCapture && is_ok((ss - 1)->currentMove))
        thisThread->lowPlyHistory[ss->ply - 1][from_to((ss - 1)->currentMove)] << stat_bonus(depth - 5);

    thisThread->ttHitAverage = (TtHitAverageWindow - 1) * thisThread->ttHitAverage / TtHitAverageWindow
                             + TtHitAverageResolution * ss->ttHit;

    if (!PvNode && ss->ttHit && tte->depth() >= depth && ttValue != VALUE_NONE
        && (ttValue >= beta ? (tte->bound() & BOUND_LOWER) : (tte->bound() & BOUND_UPPER)))
    {
        if (ttMove)
        {
            if (ttValue >= beta)
            {
                if (!pos.capture_or_promotion(ttMove))
                    update_quiet_stats(pos, ss, ttMove, stat_bonus(depth), depth);
                if ((ss - 1)->moveCount <= 2 && !priorCapture && prevSq != SQ_NONE)
                    update_continuation_histories(ss - 1, pos.piece_on(prevSq), prevSq, -stat_bonus(depth + 1));
            }
            else if (!pos.capture_or_promotion(ttMove))
            {
                int penalty = -stat_bonus(depth);
                thisThread->mainHistory[us][from_to(ttMove)] << penalty;
                if (pos.walling())
                    thisThread->gateHistory[us][gating_square(ttMove)] << penalty;
                update_continuation_histories(ss, pos.moved_piece(ttMove), to_sq(ttMove), penalty);
            }
        }
        if (pos.rule50_count() < 90)
            return ttValue;
    }

    CapturePieceToHistory& captureHistory = thisThread->captureHistory;

    if (ss->inCheck)
    {
        ss->staticEval = eval = VALUE_NONE;
        improving = false;
        goto moves_loop;
    }
    else if (ss->ttHit)
    {
        ss->staticEval = eval = tte->eval();
        if (eval == VALUE_NONE)
            ss->staticEval = eval = evaluate(pos);
        if (eval == VALUE_DRAW)
            eval = value_draw(thisThread);
        if (ttValue != VALUE_NONE && (tte->bound() & (ttValue > eval ? BOUND_LOWER : BOUND_UPPER)))
            eval = ttValue;
    }
    else
    {
        ss->staticEval = eval = ((ss - 1)->currentMove != MOVE_NULL ? evaluate(pos) : -(ss - 1)->staticEval);
        tte->save(posKey, VALUE_NONE, ss->ttPv, BOUND_NONE, DEPTH_NONE, MOVE_NONE, eval);
    }

    if (is_ok((ss - 1)->currentMove) && !(ss - 1)->inCheck && !priorCapture)
    {
        int bonus = std::clamp(-depth * 4 * int((ss - 1)->staticEval + ss->staticEval), -1000, 1000);
        thisThread->mainHistory[~us][from_to((ss - 1)->currentMove)] << bonus;
    }

    improving = (ss - 2)->staticEval == VALUE_NONE
              ? (ss->staticEval > (ss - 4)->staticEval || (ss - 4)->staticEval == VALUE_NONE)
              : (ss->staticEval > (ss - 2)->staticEval);

    if (pos.must_capture() && pos.has_capture())
        goto moves_loop;

    // Step 7. Futility Pruning (Child node)
    if (!PvNode && depth < 9 - 3 * pos.blast_on_capture()
        && eval - futility_margin(depth, improving) * (1 + pos.check_counting() + 2 * pos.must_capture() + pos.extinction_single_piece() + !pos.checking_permitted()) >= beta
        && eval < VALUE_KNOWN_WIN)
        return eval;

    // Step 8. Null Move Pruning
    if (!PvNode && (ss - 1)->currentMove != MOVE_NULL && (ss - 1)->statScore < 23767
        && eval >= beta && eval >= ss->staticEval
        && ss->staticEval >= beta - 20 * depth - 22 * improving + 168 * ss->ttPv + 159 + 200 * (!pos.double_step_region(pos.side_to_move()) && (pos.piece_types() & PAWN))
        && !excludedMove && pos.non_pawn_material(us)
        && pos.count<ALL_PIECES>(~us) != pos.count<PAWN>(~us) && !pos.flip_enclosed_pieces()
        && (ss->ply >= thisThread->nmpMinPly || us != thisThread->nmpColor))
    {
        Depth R = (1090 - 300 * pos.must_capture() - 250 * !pos.checking_permitted() + 81 * depth) / 256
                + std::min(int(eval - beta) / 205, pos.must_capture() || pos.blast_on_capture() ? 0 : 3);

        ss->currentMove = MOVE_NULL;
        ss->continuationHistory = &thisThread->continuationHistory[0][0][NO_PIECE][0];
        pos.do_null_move(st);
        Value nullValue = -search<NonPV>(pos, ss + 1, -beta, -beta + 1, depth - R, !cutNode);
        pos.undo_null_move();

        if (nullValue >= beta)
        {
            if (nullValue >= VALUE_TB_WIN_IN_MAX_PLY)
                nullValue = beta;
            if (thisThread->nmpMinPly || (std::abs(beta) < VALUE_KNOWN_WIN && depth < 14))
                return nullValue;

            thisThread->nmpMinPly = ss->ply + 3 * (depth - R) / 4;
            thisThread->nmpColor = us;
            Value v = search<NonPV>(pos, ss, beta - 1, beta, depth - R, false);
            thisThread->nmpMinPly = 0;
            if (v >= beta)
                return nullValue;
        }
    }

    probCutBeta = beta + (209 + 20 * !pos.flag_region(~pos.side_to_move()) + 50 * pos.captures_to_hand()) * (1 + pos.check_counting() + pos.extinction_single_piece()) - 44 * improving;

    // Step 9. ProbCut
    if (!PvNode && depth > 4 && std::abs(beta) < VALUE_TB_WIN_IN_MAX_PLY
        && !(ss->ttHit && tte->depth() >= depth - 3 && ttValue != VALUE_NONE && ttValue < probCutBeta))
    {
        MovePicker mp(pos, ttMove, probCutBeta - ss->staticEval, &thisThread->gateHistory, &captureHistory);
        int probCutCount = 0;
        bool ttPv = ss->ttPv;
        ss->ttPv = false;

        while ((move = mp.next_move()) != MOVE_NONE && probCutCount < 2 + 2 * cutNode)
        {
            if (move != excludedMove && pos.legal(move))
            {
                probCutCount++;
                ss->currentMove = move;
                ss->continuationHistory = &thisThread->continuationHistory[ss->inCheck][true][history_slot(pos.moved_piece(move))][to_sq(move)];

                pos.do_move(move, st);
                value = -qsearch<NonPV>(pos, ss + 1, -probCutBeta, -probCutBeta + 1);
                if (value >= probCutBeta)
                    value = -search<NonPV>(pos, ss + 1, -probCutBeta, -probCutBeta + 1, depth - 4, !cutNode);
                pos.undo_move(move);

                if (value >= probCutBeta)
                {
                    if (!(ss->ttHit && tte->depth() >= depth - 3 && ttValue != VALUE_NONE))
                        tte->save(posKey, value_to_tt(value, ss->ply), ttPv, BOUND_LOWER, depth - 3, move, ss->staticEval);
                    return value;
                }
            }
        }
        ss->ttPv = ttPv;
    }

    if (PvNode && depth >= 6 && !ttMove)
        depth -= 2;

moves_loop:
    ttCapture = ttMove && pos.capture_or_promotion(ttMove);

    const PieceToHistory* contHist[] = {
        (ss - 1)->continuationHistory, (ss - 2)->continuationHistory,
        (ss - 3)->continuationHistory, (ss - 4)->continuationHistory,
        (ss - 5)->continuationHistory, (ss - 6)->continuationHistory
    };

    Move countermove = (prevSq != SQ_NONE ? thisThread->counterMoves[pos.piece_on(prevSq)][prevSq] : MOVE_NONE);

    MovePicker mp(pos, ttMove, depth, &thisThread->mainHistory, &thisThread->gateHistory,
                  &thisThread->lowPlyHistory, &captureHistory, contHist, countermove, ss->killers, ss->ply);

    value = bestValue;
    singularQuietLMR = moveCountPruning = false;
    bool doubleExtension = false;

    bool likelyFailLow = PvNode && ttMove && (tte->bound() & BOUND_UPPER) && tte->depth() >= depth;

    while ((move = mp.next_move(moveCountPruning)) != MOVE_NONE)
    {
        if (move == excludedMove)
            continue;

        if (rootNode && !std::count(thisThread->rootMoves.begin() + thisThread->pvIdx,
                                    thisThread->rootMoves.begin() + thisThread->pvLast, move))
            continue;

        if (!rootNode && !pos.legal(move))
            continue;

        ss->moveCount = ++moveCount;

        if (PvNode)
            (ss + 1)->pv = nullptr;

        extension = 0;
        captureOrPromotion = pos.capture_or_promotion(move);
        movedPiece = pos.moved_piece(move);
        givesCheck = pos.gives_check(move);
        newDepth = depth - 1;

        // Step 13. Pruning at shallow depth
        if (!rootNode && (pos.non_pawn_material(us) || pos.count<ALL_PIECES>(us) == pos.count<PAWN>(us))
            && bestValue > VALUE_TB_LOSS_IN_MAX_PLY)
        {
            moveCountPruning = moveCount >= futility_move_count(improving, depth, pos);
            int lmrDepth = std::max(newDepth - reduction(improving, depth, moveCount), 0);

            if (pos.must_capture() && pos.attackers_to(to_sq(move), ~us))
            {}
            else if (captureOrPromotion || givesCheck)
            {
                if (!givesCheck && lmrDepth < 1
                    && captureHistory[movedPiece][to_sq(move)][type_of(pos.piece_on(to_sq(move)))] < 0)
                    continue;

                if (!pos.see_ge(move, Value(-218 - 120 * pos.captures_to_hand()) * depth))
                    continue;
            }
            else
            {
                if (lmrDepth < 5
                    && (*contHist[0])[history_slot(movedPiece)][to_sq(move)] < CounterMovePruneThreshold
                    && (*contHist[1])[history_slot(movedPiece)][to_sq(move)] < CounterMovePruneThreshold)
                    continue;

                if (lmrDepth < 7 && !ss->inCheck && !pos.extinction_single_piece()
                    && ss->staticEval + (174 + 157 * lmrDepth) * (1 + pos.check_counting()) <= alpha
                    && (*contHist[0])[history_slot(movedPiece)][to_sq(move)]
                     + (*contHist[1])[history_slot(movedPiece)][to_sq(move)]
                     + (*contHist[3])[history_slot(movedPiece)][to_sq(move)]
                     + (*contHist[5])[history_slot(movedPiece)][to_sq(move)] / 3 < 28255)
                    continue;

                if (!(pos.walling_rule() == DUCK)
                    && !pos.see_ge(move, Value(-(30 - std::min(lmrDepth, 18) + 10 * !pos.flag_region(pos.side_to_move())) * lmrDepth * lmrDepth)))
                    continue;
            }
        }

        // Step 14. Singular Extensions (Janggi-Adapted)
        if (!rootNode && depth >= 6 + ss->ttPv - (pos.count<KING>() == 1 ? 2 : 0)
            && move == ttMove && !excludedMove && std::abs(ttValue) < VALUE_KNOWN_WIN
            && (tte->bound() & BOUND_LOWER) && tte->depth() >= depth - 3)
        {
            Value singularBeta = ttValue - (50 + 60 * (ss->ttPv && !PvNode)) * depth / 64;
            Depth singularDepth = (depth - 1) / 2;

            ss->excludedMove = move;
            value = search<NonPV>(pos, ss, singularBeta - 1, singularBeta, singularDepth, cutNode);
            ss->excludedMove = MOVE_NONE;

            if (value < singularBeta)
            {
                extension = 1;
                singularQuietLMR = !ttCapture;

                if (!PvNode && value < singularBeta - 93 && ss->doubleExtensions < 3)
                {
                    extension = 2;
                    doubleExtension = true;
                }
            }
            else if (singularBeta >= beta)
                return singularBeta;
            else if (ttValue >= beta)
            {
                ss->excludedMove = move;
                value = search<NonPV>(pos, ss, beta - 1, beta, (depth + 3) / 2, cutNode);
                ss->excludedMove = MOVE_NONE;
                if (value >= beta)
                    return beta;
            }
        }
        else if (givesCheck && depth > 6 && std::abs(ss->staticEval) > Value(100))
            extension = 1;

        else if (pos.must_capture() && pos.capture(move) && (ss->inCheck || MoveList<CAPTURES>(pos).size() == 1))
            extension = 1;

        newDepth += extension;
        ss->doubleExtensions = (ss - 1)->doubleExtensions + (extension == 2);

        ss->currentMove = move;
        ss->continuationHistory = &thisThread->continuationHistory[ss->inCheck][captureOrPromotion][history_slot(movedPiece)][to_sq(move)];

        pos.do_move(move, st, givesCheck);

        // Step 16. Late Moves Reduction (LMR) + Dynamic Re-Search
        if (depth >= 3 && moveCount > 1 + 2 * rootNode
            && !(pos.must_capture() && pos.has_capture())
            && (!captureOrPromotion || (cutNode && (ss - 1)->moveCount > 1) || !ss->ttPv)
            && (!PvNode || ss->ply > 1 || thisThread->id() % 4 != 3))
        {
            Depth r = reduction(improving, depth, moveCount);

            if (PvNode)
                r--;

            if (thisThread->ttHitAverage > 537 * TtHitAverageResolution * TtHitAverageWindow / 1024)
                r--;

            if (ss->ttPv && !likelyFailLow)
                r -= 2;

            if ((rootNode || !PvNode) && thisThread->bestMoveChanges <= 2)
                r++;

            if ((ss - 1)->moveCount > 13)
                r--;

            if (singularQuietLMR)
                r--;

            if (cutNode)
                r += 1 + !captureOrPromotion;

            if (!captureOrPromotion)
            {
                if (ttCapture)
                    r++;

                ss->statScore = thisThread->mainHistory[us][from_to(move)]
                              + (pos.walling() ? thisThread->gateHistory[us][gating_square(move)] * 2 : 0)
                              + (*contHist[0])[history_slot(movedPiece)][to_sq(move)]
                              + (*contHist[1])[history_slot(movedPiece)][to_sq(move)]
                              + (*contHist[3])[history_slot(movedPiece)][to_sq(move)]
                              - 4923;

                if (!ss->inCheck)
                    r -= ss->statScore / (14721 - 4434 * pos.captures_to_hand());
            }

            Depth d = std::clamp(newDepth - r, 1, newDepth + (r < -1 && moveCount <= 5 && !doubleExtension));

            value = -search<NonPV>(pos, ss + 1, -(alpha + 1), -alpha, d, true);

            if (value > alpha && d < newDepth)
            {
                const bool doDeeperSearch = (value > bestValue + 53);
                const bool doShallowerSearch = (value < bestValue + 8);
                Depth researchDepth = newDepth + doDeeperSearch - doShallowerSearch;

                value = -search<NonPV>(pos, ss + 1, -(alpha + 1), -alpha, researchDepth, !cutNode);

                if (!captureOrPromotion)
                    update_continuation_histories(ss, movedPiece, to_sq(move), stat_bonus(newDepth));
            }
            doFullDepthSearch = false;
            didLMR = true;
        }
        else
        {
            doFullDepthSearch = !PvNode || moveCount > 1;
            didLMR = false;
        }

        if (doFullDepthSearch)
        {
            value = -search<NonPV>(pos, ss + 1, -(alpha + 1), -alpha, newDepth, !cutNode);
            if (didLMR && !captureOrPromotion)
            {
                int bonus = value > alpha ? stat_bonus(newDepth) : -stat_bonus(newDepth);
                update_continuation_histories(ss, movedPiece, to_sq(move), bonus);
            }
        }

        if (PvNode && (moveCount == 1 || (value > alpha && (rootNode || value < beta))))
        {
            (ss + 1)->pv = pv;
            (ss + 1)->pv[0] = MOVE_NONE;
            value = -search<PV>(pos, ss + 1, -beta, -alpha, std::min(maxNextDepth, newDepth), false);
        }

        pos.undo_move(move);
        assert(value > -VALUE_INFINITE && value < VALUE_INFINITE);

        if (Threads.stop.load(std::memory_order_relaxed))
            return VALUE_ZERO;

        if (rootNode)
        {
            RootMove& rm = *std::find(thisThread->rootMoves.begin(), thisThread->rootMoves.end(), move);
            if (moveCount == 1 || value > alpha)
            {
                rm.score = value;
                rm.selDepth = thisThread->selDepth;
                rm.pv.resize(1);
                for (Move* m = (ss + 1)->pv; *m != MOVE_NONE; ++m)
                    rm.pv.push_back(*m);
                if (moveCount > 1)
                    ++thisThread->bestMoveChanges;
            }
            else
                rm.score = -VALUE_INFINITE;
        }

        if (value > bestValue)
        {
            bestValue = value;
            if (value > alpha)
            {
                bestMove = move;
                if (PvNode && !rootNode)
                    update_pv(ss->pv, move, (ss + 1)->pv);

                if (PvNode && value < beta)
                    alpha = value;
                else
                {
                    assert(value >= beta);
                    break;
                }
            }
        }

        if (move != bestMove)
        {
            if (captureOrPromotion && captureCount < 32)
                capturesSearched[captureCount++] = move;
            else if (!captureOrPromotion && quietCount < 64)
                quietsSearched[quietCount++] = move;
        }
    }

    if (!moveCount)
        bestValue = excludedMove ? alpha : ss->inCheck ? pos.checkmate_value(ss->ply) : pos.stalemate_value(ss->ply);
    else if (bestMove)
        update_all_stats(pos, ss, bestMove, bestValue, beta, prevSq, quietsSearched, quietCount,
                         capturesSearched, captureCount, depth);
    else if ((depth >= 3 || PvNode) && !priorCapture && prevSq != SQ_NONE)
        update_continuation_histories(ss - 1, pos.piece_on(prevSq), prevSq, stat_bonus(depth));

    if (PvNode)
        bestValue = std::min(bestValue, maxValue);

    if (bestValue <= alpha)
        ss->ttPv = ss->ttPv || ((ss - 1)->ttPv && depth > 3);
    else if (depth > 3)
        ss->ttPv = ss->ttPv && (ss + 1)->ttPv;

    if (!excludedMove && !(rootNode && thisThread->pvIdx))
        tte->save(posKey, value_to_tt(bestValue, ss->ply), ss->ttPv,
                  bestValue >= beta ? BOUND_LOWER : (PvNode && bestMove ? BOUND_EXACT : BOUND_UPPER),
                  depth, bestMove, ss->staticEval);

    return bestValue;
}

template <NodeType nodeType>
Value qsearch(Position& pos, Stack* ss, Value alpha, Value beta, Depth depth) {
    constexpr bool PvNode = (nodeType == PV);
    assert(alpha >= -VALUE_INFINITE && alpha < beta && beta <= VALUE_INFINITE);

    Move pv[MAX_PLY + 1];
    StateInfo st;
    ASSERT_ALIGNED(&st, Eval::NNUE::CacheLineSize);

    TTEntry* tte;
    Key posKey;
    Move ttMove, move, bestMove = MOVE_NONE;
    Depth ttDepth;
    Value bestValue, value, ttValue, futilityValue, futilityBase, oldAlpha;
    bool pvHit, givesCheck, captureOrPromotion;
    int moveCount = 0;

    if (PvNode)
    {
        oldAlpha = alpha;
        (ss + 1)->pv = pv;
        ss->pv[0] = MOVE_NONE;
    }

    Thread* thisThread = pos.this_thread();
    ss->inCheck = pos.checkers();

    Value gameResult;
    if (pos.is_game_end(gameResult, ss->ply))
        return gameResult;

    if (ss->ply >= MAX_PLY)
        return !ss->inCheck ? evaluate(pos) : VALUE_DRAW;

    if (depth < DEPTH_QS_MAX && !ss->inCheck)
        return evaluate(pos);

    ttDepth = ss->inCheck || depth >= DEPTH_QS_CHECKS ? DEPTH_QS_CHECKS : DEPTH_QS_NO_CHECKS;
    posKey = pos.key();
    tte = TT.probe(posKey, ss->ttHit);
    ttValue = ss->ttHit ? value_from_tt(tte->value(), ss->ply, pos.rule50_count()) : VALUE_NONE;
    ttMove = ss->ttHit ? tte->move() : MOVE_NONE;
    pvHit = ss->ttHit && tte->is_pv();

    if (!PvNode && ss->ttHit && tte->depth() >= ttDepth && ttValue != VALUE_NONE
        && (ttValue >= beta ? (tte->bound() & BOUND_LOWER) : (tte->bound() & BOUND_UPPER)))
        return ttValue;

    if (ss->inCheck)
    {
        ss->staticEval = VALUE_NONE;
        bestValue = futilityBase = -VALUE_INFINITE;
    }
    else
    {
        if (ss->ttHit)
        {
            if ((ss->staticEval = bestValue = tte->eval()) == VALUE_NONE)
                ss->staticEval = bestValue = evaluate(pos);
            if (ttValue != VALUE_NONE && (tte->bound() & (ttValue > bestValue ? BOUND_LOWER : BOUND_UPPER)))
                bestValue = ttValue;
        }
        else
            ss->staticEval = bestValue = ((ss - 1)->currentMove != MOVE_NULL ? evaluate(pos) : -(ss - 1)->staticEval);

        if (bestValue >= beta)
        {
            if (!ss->ttHit)
                tte->save(posKey, value_to_tt(bestValue, ss->ply), false, BOUND_LOWER, DEPTH_NONE, MOVE_NONE, ss->staticEval);
            return bestValue;
        }

        if (PvNode && bestValue > alpha)
            alpha = bestValue;

        futilityBase = bestValue + 155;
    }

    const PieceToHistory* contHist[] = {
        (ss - 1)->continuationHistory, (ss - 2)->continuationHistory,
        (ss - 3)->continuationHistory, (ss - 4)->continuationHistory,
        (ss - 5)->continuationHistory, (ss - 6)->continuationHistory
    };

    MovePicker mp(pos, ttMove, depth, &thisThread->mainHistory, &thisThread->gateHistory,
                  &thisThread->captureHistory, contHist, to_sq((ss - 1)->currentMove));

    while ((move = mp.next_move()) != MOVE_NONE)
    {
        givesCheck = pos.gives_check(move);
        captureOrPromotion = pos.capture_or_promotion(move);
        moveCount++;

        if (bestValue > VALUE_TB_LOSS_IN_MAX_PLY && !givesCheck
            && !(pos.extinction_value() == -VALUE_MATE && pos.piece_on(to_sq(move)) && (pos.extinction_piece_types() & type_of(pos.piece_on(to_sq(move))))))
        {
            if (moveCount > 2)
                continue;

            futilityValue = futilityBase + PieceValue[EG][pos.piece_on(to_sq(move))];
            if (futilityValue <= alpha)
            {
                bestValue = std::max(bestValue, futilityValue);
                continue;
            }
            if (futilityBase <= alpha && !pos.see_ge(move, VALUE_ZERO + 1))
            {
                bestValue = std::max(bestValue, futilityBase);
                continue;
            }
        }

        if (bestValue > VALUE_TB_LOSS_IN_MAX_PLY && !pos.see_ge(move))
            continue;

        prefetch(TT.first_entry(pos.key_after(move)));

        if (!pos.legal(move))
        {
            moveCount--;
            continue;
        }

        ss->currentMove = move;
        ss->continuationHistory = &thisThread->continuationHistory[ss->inCheck][captureOrPromotion][history_slot(pos.moved_piece(move))][to_sq(move)];

        if (!captureOrPromotion && bestValue > VALUE_TB_LOSS_IN_MAX_PLY
            && (*contHist[0])[history_slot(pos.moved_piece(move))][to_sq(move)] < CounterMovePruneThreshold
            && (*contHist[1])[history_slot(pos.moved_piece(move))][to_sq(move)] < CounterMovePruneThreshold)
            continue;

        pos.do_move(move, st, givesCheck);
        value = -qsearch<nodeType>(pos, ss + 1, -beta, -alpha, depth - 1);
        pos.undo_move(move);

        if (value > bestValue)
        {
            bestValue = value;
            if (value > alpha)
            {
                bestMove = move;
                if (PvNode)
                    update_pv(ss->pv, move, (ss + 1)->pv);
                if (PvNode && value < beta)
                    alpha = value;
                else
                    break;
            }
        }
    }

    if (ss->inCheck && bestValue == -VALUE_INFINITE)
        return pos.checkmate_value(ss->ply);

    tte->save(posKey, value_to_tt(bestValue, ss->ply), pvHit,
              bestValue >= beta ? BOUND_LOWER : (PvNode && bestValue > oldAlpha ? BOUND_EXACT : BOUND_UPPER),
              ttDepth, bestMove, ss->staticEval);

    return bestValue;
}

Value value_to_tt(Value v, int ply) {
    return (v >= VALUE_TB_WIN_IN_MAX_PLY ? v + ply : v <= VALUE_TB_LOSS_IN_MAX_PLY ? v - ply : v);
}

Value value_from_tt(Value v, int ply, int r50c) {
    if (v == VALUE_NONE) return VALUE_NONE;
    if (v >= VALUE_TB_WIN_IN_MAX_PLY)
    {
        if (v >= VALUE_MATE_IN_MAX_PLY && VALUE_MATE - v > 99 - r50c)
            return VALUE_MATE_IN_MAX_PLY - 1;
        return v - ply;
    }
    if (v <= VALUE_TB_LOSS_IN_MAX_PLY)
    {
        if (v <= VALUE_MATED_IN_MAX_PLY && VALUE_MATE + v > 99 - r50c)
            return VALUE_MATED_IN_MAX_PLY + 1;
        return v + ply;
    }
    return v;
}

void update_pv(Move* pv, Move move, Move* childPv) {
    for (*pv++ = move; childPv && *childPv != MOVE_NONE;)
        *pv++ = *childPv++;
    *pv = MOVE_NONE;
}

void update_continuation_histories(Stack* ss, Piece pc, Square to, int bonus) {
    static constexpr std::array<std::pair<int, int>, 6> conthist_weights = {{
        {1, 1024}, {2, 768}, {3, 512}, {4, 384}, {5, 256}, {6, 128}
    }};

    for (const auto& [i, weight] : conthist_weights)
    {
        if (ss->inCheck && i > 2) break;
        if (is_ok((ss - i)->currentMove))
            (*(ss - i)->continuationHistory)[history_slot(pc)][to] << (bonus * weight / 1024);
    }
}

void update_quiet_stats(const Position& pos, Stack* ss, Move move, int bonus, int depth) {
    if (ss->killers[0] != move)
    {
        ss->killers[1] = ss->killers[0];
        ss->killers[0] = move;
    }

    Color us = pos.side_to_move();
    Thread* thisThread = pos.this_thread();
    thisThread->mainHistory[us][from_to(move)] << bonus;
    if (pos.walling())
        thisThread->gateHistory[us][gating_square(move)] << bonus;

    update_continuation_histories(ss, pos.moved_piece(move), to_sq(move), bonus);

    if (type_of(pos.moved_piece(move)) != PAWN && type_of(move) != DROP)
        thisThread->mainHistory[us][from_to(reverse_move(move))] << -bonus;

    if (is_ok((ss - 1)->currentMove))
    {
        Square prevSq = to_sq((ss - 1)->currentMove);
        thisThread->counterMoves[pos.piece_on(prevSq)][prevSq] = move;
    }

    if (depth > 11 && ss->ply < MAX_LPH)
        thisThread->lowPlyHistory[ss->ply][from_to(move)] << stat_bonus(depth - 7);
}

void update_all_stats(const Position& pos, Stack* ss, Move bestMove, Value bestValue, Value beta, Square prevSq,
                      Move* quietsSearched, int quietCount, Move* capturesSearched, int captureCount, Depth depth) {
    Color us = pos.side_to_move();
    Thread* thisThread = pos.this_thread();
    CapturePieceToHistory& captureHistory = thisThread->captureHistory;
    Piece moved_piece = pos.moved_piece(bestMove);
    PieceType captured = type_of(pos.piece_on(to_sq(bestMove)));

    int bonus1 = stat_bonus(depth + 1);
    int bonus2 = (bestValue > beta + PawnValueMg) ? (bonus1 + bonus1 / 4) : std::min(bonus1, stat_bonus(depth));

    if (!pos.capture_or_promotion(bestMove))
    {
        update_quiet_stats(pos, ss, bestMove, bonus2, depth);
        for (int i = 0; i < quietCount; ++i)
        {
            if (!(pos.walling() && from_to(quietsSearched[i]) == from_to(bestMove)))
                thisThread->mainHistory[us][from_to(quietsSearched[i])] << -bonus2;
            if (pos.walling())
                thisThread->gateHistory[us][gating_square(quietsSearched[i])] << -bonus2;
            update_continuation_histories(ss, pos.moved_piece(quietsSearched[i]), to_sq(quietsSearched[i]), -bonus2);
        }
    }
    else
    {
        captureHistory[moved_piece][to_sq(bestMove)][captured] << bonus1;
        if (pos.walling())
            thisThread->gateHistory[us][gating_square(bestMove)] << bonus1;
    }

    if (((ss - 1)->moveCount == 1 + (ss - 1)->ttHit || ((ss - 1)->currentMove == (ss - 1)->killers[0]))
        && !pos.captured_piece())
        update_continuation_histories(ss - 1, pos.piece_on(prevSq), prevSq, -bonus1);

    for (int i = 0; i < captureCount; ++i)
    {
        moved_piece = pos.moved_piece(capturesSearched[i]);
        captured = type_of(pos.piece_on(to_sq(capturesSearched[i])));
        if (!(pos.walling() && from_to(capturesSearched[i]) == from_to(bestMove)))
            captureHistory[moved_piece][to_sq(capturesSearched[i])][captured] << -bonus1;
        if (pos.walling())
            thisThread->gateHistory[us][gating_square(capturesSearched[i])] << -bonus1;
    }
}

Move Skill::pick_best(size_t multiPV) {
    const RootMoves& rootMoves = Threads.main()->rootMoves;
    static PRNG rng(now());

    Value topScore = rootMoves[0].score;
    int delta = std::min(topScore - rootMoves[multiPV - 1].score, PawnValueMg);
    int weakness = 120 - 2 * level;
    int maxScore = -VALUE_INFINITE;

    for (size_t i = 0; i < multiPV; ++i)
    {
        int push = (weakness * int(topScore - rootMoves[i].score)
                    + delta * (rng.rand<unsigned>() % weakness)) / 128;

        if (rootMoves[i].score + push >= maxScore)
        {
            maxScore = rootMoves[i].score + push;
            best = rootMoves[i].pv[0];
        }
    }

    return best;
}

} // namespace

void MainThread::check_time() {
    if (--callsCnt > 0)
        return;

    callsCnt = Limits.nodes ? std::min(1024, int(Limits.nodes / 1024)) : 1024;

    static TimePoint lastInfoTime = now();
    TimePoint elapsed = Time.elapsed();
    TimePoint tick = Limits.startTime + elapsed;

    if (tick - lastInfoTime >= 1000)
    {
        lastInfoTime = tick;
        dbg_print();
    }

    if (ponder)
        return;

    if (rootPos.two_boards()
        && Time.elapsed() < Limits.time[rootPos.side_to_move()] - 1000
        && (Partner.sitRequested || (Partner.weDead && !Partner.partnerDead) || Partner.weVirtualWin))
        return;

    if ((Limits.use_time_management() && (elapsed > Time.maximum() - 10 || stopOnPonderhit))
        || (Limits.movetime && elapsed >= Limits.movetime)
        || (Limits.nodes && Threads.nodes_searched() >= (uint64_t)Limits.nodes))
        Threads.stop = true;
}

string UCI::pv(const Position& pos, Depth depth, Value alpha, Value beta) {
    std::stringstream ss;
    TimePoint elapsed = Time.elapsed() + 1;
    const RootMoves& rootMoves = pos.this_thread()->rootMoves;
    size_t pvIdx = pos.this_thread()->pvIdx;
    size_t multiPV = std::min((size_t)Options["MultiPV"], rootMoves.size());
    uint64_t nodesSearched = Threads.nodes_searched();
    uint64_t tbHits = Threads.tb_hits() + (TB::RootInTB ? rootMoves.size() : 0);

    for (size_t i = 0; i < multiPV; ++i)
    {
        bool updated = rootMoves[i].score != -VALUE_INFINITE;

        if (depth == 1 && !updated && i > 0)
            continue;

        Depth d = updated ? depth : std::max(1, depth - 1);
        Value v = updated ? rootMoves[i].score : rootMoves[i].previousScore;

        if (v == -VALUE_INFINITE)
            v = VALUE_ZERO;

        bool tb = TB::RootInTB && std::abs(v) < VALUE_MATE_IN_MAX_PLY;
        v = tb ? rootMoves[i].tbScore : v;

        if (ss.rdbuf()->in_avail())
            ss << "\n";

        if (CurrentProtocol == XBOARD)
        {
            ss << d << " " << UCI::value(v) << " " << elapsed / 10 << " "
               << nodesSearched << " " << rootMoves[i].selDepth << " "
               << nodesSearched * 1000 / elapsed << " " << tbHits << "\t";
            if (!pos.two_boards())
                for (Move m : rootMoves[i].pv)
                    ss << " " << UCI::move(pos, m);
        }
        else
        {
            ss << "info depth " << d << " seldepth " << rootMoves[i].selDepth
               << " multipv " << i + 1 << " score " << UCI::value(v);

            if (Options["UCI_ShowWDL"])
                ss << UCI::wdl(v, pos.game_ply());

            if (!tb && i == pvIdx)
                ss << (v >= beta ? " lowerbound" : v <= alpha ? " upperbound" : "");

            ss << " nodes " << nodesSearched << " nps " << nodesSearched * 1000 / elapsed;

            if (elapsed > 1000)
                ss << " hashfull " << TT.hashfull();

            ss << " tbhits " << tbHits << " time " << elapsed << " pv";

            for (Move m : rootMoves[i].pv)
                ss << " " << UCI::move(pos, m);
        }
    }

    return ss.str();
}

bool Search::RootMove::extract_ponder_from_tt(Position& pos) {
    StateInfo st;
    ASSERT_ALIGNED(&st, Eval::NNUE::CacheLineSize);
    bool ttHit;

    assert(pv.size() == 1);
    if (pv[0] == MOVE_NONE)
        return false;

    pos.do_move(pv[0], st);
    TTEntry* tte = TT.probe(pos.key(), ttHit);

    if (ttHit)
    {
        Move m = tte->move();
        if (MoveList<LEGAL>(pos).contains(m))
            pv.push_back(m);
    }

    pos.undo_move(pv[0]);
    return pv.size() > 1;
}

void Tablebases::rank_root_moves(Position& pos, Search::RootMoves& rootMoves) {
    RootInTB = false;
    UseRule50 = bool(Options["Syzygy50MoveRule"]);
    ProbeDepth = int(Options["SyzygyProbeDepth"]);
    Cardinality = int(Options["SyzygyProbeLimit"]);
    bool dtz_available = true;

    if (Cardinality > MaxCardinality)
    {
        Cardinality = MaxCardinality;
        ProbeDepth = 0;
    }

    if (Cardinality >= popcount(pos.pieces()) && !pos.can_castle(ANY_CASTLING))
    {
        RootInTB = root_probe(pos, rootMoves);
        if (!RootInTB)
        {
            dtz_available = false;
            RootInTB = root_probe_wdl(pos, rootMoves);
        }
    }

    if (RootInTB)
    {
        std::stable_sort(rootMoves.begin(), rootMoves.end(),
                         [](const RootMove& a, const RootMove& b) { return a.tbRank > b.tbRank; });
        if (dtz_available || rootMoves[0].tbScore <= VALUE_DRAW)
            Cardinality = 0;
    }
    else
    {
        for (auto& m : rootMoves)
            m.tbRank = 0;
    }
}

} // namespace Stockfish