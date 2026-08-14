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

#include "movepick.h"
#include <cassert>
#include <algorithm>

namespace Stockfish {

int history_slot(Piece pc) {
    return pc == NO_PIECE ? 0 : (type_of(pc) == KING ? PIECE_SLOTS - 1 : type_of(pc) % (PIECE_SLOTS - 1)) + color_of(pc) * PIECE_SLOTS;
}

namespace {

enum Stages {
    MAIN_TT, CAPTURE_INIT, GOOD_CAPTURE, REFUTATION, QUIET_INIT, QUIET, BAD_CAPTURE,
    EVASION_TT, EVASION_INIT, EVASION,
    PROBCUT_TT, PROBCUT_INIT, PROBCUT,
    QSEARCH_TT, QCAPTURE_INIT, QCAPTURE, QCHECK_INIT, QCHECK
};

void partial_insertion_sort(ExtMove* begin, ExtMove* end, int limit) {
    for (ExtMove *sortedEnd = begin, *p = begin + 1; p < end; ++p)
        if (p->value >= limit)
        {
            ExtMove tmp = *p, *q;
            *p = *++sortedEnd;
            for (q = sortedEnd; q != begin && *(q - 1) < tmp; --q)
                *q = *(q - 1);
            *q = tmp;
        }
}

} // namespace

MovePicker::MovePicker(const Position& p, Move ttm, Depth d, const ButterflyHistory* mh, const GateHistory* dh, const LowPlyHistory* lp,
                       const CapturePieceToHistory* cph, const PieceToHistory** ch, Move cm, const Move* killers, int pl)
    : pos(p), mainHistory(mh), gateHistory(dh), lowPlyHistory(lp), captureHistory(cph), continuationHistory(ch),
      ttMove(ttm), refutations{{killers[0], 0}, {killers[1], 0}, {cm, 0}}, depth(d), ply(pl) {

    assert(d > 0);
    stage = (pos.checkers() ? EVASION_TT : MAIN_TT) + !(ttm && pos.pseudo_legal(ttm));
}

MovePicker::MovePicker(const Position& p, Move ttm, Depth d, const ButterflyHistory* mh, const GateHistory* dh,
                       const CapturePieceToHistory* cph, const PieceToHistory** ch, Square rs)
    : pos(p), mainHistory(mh), gateHistory(dh), lowPlyHistory(nullptr), captureHistory(cph), continuationHistory(ch),
      ttMove(ttm), recaptureSquare(rs), depth(d), ply(0) {

    assert(d <= 0);
    stage = (pos.checkers() ? EVASION_TT : QSEARCH_TT) +
            !(ttm && (pos.checkers() || depth > DEPTH_QS_RECAPTURES || to_sq(ttm) == recaptureSquare) && pos.pseudo_legal(ttm));
}

MovePicker::MovePicker(const Position& p, Move ttm, Value th, const GateHistory* dh, const CapturePieceToHistory* cph)
    : pos(p), mainHistory(nullptr), gateHistory(dh), lowPlyHistory(nullptr), captureHistory(cph), continuationHistory(nullptr),
      ttMove(ttm), threshold(th), depth(0), ply(0) {

    assert(!pos.checkers());
    stage = PROBCUT_TT + !(ttm && pos.capture(ttm) && pos.pseudo_legal(ttm) && pos.see_ge(ttm, threshold));
}

template<GenType Type>
void MovePicker::score() {
    static_assert(Type == CAPTURES || Type == QUIETS || Type == EVASIONS, "Wrong type");

    Color us = pos.side_to_move();

    for (auto& m : *this)
    {
        Square to = to_sq(m.move);
        Piece pc = pos.moved_piece(m.move);

        if constexpr (Type == CAPTURES)
            m.value = int(PieceValue[MG][pos.piece_on(to)]) * 6
                    + (gateHistory ? (*gateHistory)[us][gating_square(m.move)] : 0)
                    + (*captureHistory)[pc][to][type_of(pos.piece_on(to))];

        else if constexpr (Type == QUIETS)
            m.value = (*mainHistory)[us][from_to(m.move)]
                    + (gateHistory ? (*gateHistory)[us][gating_square(m.move)] : 0)
                    + 2 * (*continuationHistory[0])[history_slot(pc)][to]
                    + (*continuationHistory[1])[history_slot(pc)][to]
                    + (*continuationHistory[3])[history_slot(pc)][to]
                    + (*continuationHistory[5])[history_slot(pc)][to]
                    + (ply < MAX_LPH ? std::min(4, depth / 3) * (*lowPlyHistory)[ply][from_to(m.move)] : 0);

        else // EVASIONS
        {
            if (pos.capture(m.move))
                m.value = PieceValue[MG][pos.piece_on(to)] - Value(type_of(pc));
            else
                m.value = (*mainHistory)[us][from_to(m.move)]
                        + 2 * (*continuationHistory[0])[history_slot(pc)][to]
                        - (1 << 28);
        }
    }
}

template<MovePicker::PickType T, typename Pred>
Move MovePicker::select(Pred filter) {
    while (cur < endMoves)
    {
        if (T == Best)
            std::swap(*cur, *std::max_element(cur, endMoves));

        if (cur->move != ttMove && filter())
            return (cur++)->move;

        cur++;
    }
    return MOVE_NONE;
}

Move MovePicker::next_move(bool skipQuiets) {

top:
    switch (stage) {

    case MAIN_TT:
    case EVASION_TT:
    case QSEARCH_TT:
    case PROBCUT_TT:
        ++stage;
        return ttMove;

    case CAPTURE_INIT:
    case PROBCUT_INIT:
    case QCAPTURE_INIT:
        cur = endBadCaptures = moves;
        endMoves = generate<CAPTURES>(pos, cur);
        score<CAPTURES>();
        ++stage;
        goto top;

    case GOOD_CAPTURE:
        if (select<Best>([&]() {
            return pos.see_ge(cur->move, Value(-69 * cur->value / 1024))
                   ? true : (*endBadCaptures++ = *cur, false);
        }))
            return (cur - 1)->move;

        cur = std::begin(refutations);
        endMoves = std::end(refutations);

        if (refutations[0].move == refutations[2].move || refutations[1].move == refutations[2].move)
            --endMoves;

        ++stage;
        [[fallthrough]];

    case REFUTATION:
        if (select<Next>([&]() {
            return cur->move != MOVE_NONE && !pos.capture(cur->move) && pos.pseudo_legal(cur->move);
        }))
            return (cur - 1)->move;
        ++stage;
        [[fallthrough]];

    case QUIET_INIT:
        if (!skipQuiets && !(pos.must_capture() && pos.has_capture()))
        {
            cur = endBadCaptures;
            endMoves = generate<QUIETS>(pos, cur);
            score<QUIETS>();
            partial_insertion_sort(cur, endMoves, -3000 * depth);
        }

        ++stage;
        [[fallthrough]];

    case QUIET:
        if (!skipQuiets && select<Next>([&]() {
            return cur->move != refutations[0].move
                && cur->move != refutations[1].move
                && cur->move != refutations[2].move;
        }))
            return (cur - 1)->move;

        cur = moves;
        endMoves = endBadCaptures;
        ++stage;
        [[fallthrough]];

    case BAD_CAPTURE:
        return select<Next>([]() { return true; });

    case EVASION_INIT:
        cur = moves;
        endMoves = generate<EVASIONS>(pos, cur);
        score<EVASIONS>();
        ++stage;
        [[fallthrough]];

    case EVASION:
        return select<Best>([]() { return true; });

    case PROBCUT:
        return select<Best>([&]() { return pos.see_ge(cur->move, threshold); });

    case QCAPTURE:
        if (select<Best>([&]() {
            return depth > DEPTH_QS_RECAPTURES || to_sq(cur->move) == recaptureSquare;
        }))
            return (cur - 1)->move;

        if (depth != DEPTH_QS_CHECKS)
            return MOVE_NONE;

        ++stage;
        [[fallthrough]];

    case QCHECK_INIT:
        cur = moves;
        endMoves = generate<QUIET_CHECKS>(pos, cur);
        ++stage;
        [[fallthrough]];

    case QCHECK:
        return select<Next>([]() { return true; });
    }

    assert(false);
    return MOVE_NONE;
}

} // namespace Stockfish