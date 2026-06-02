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

#ifndef SEARCH_H_INCLUDED
#define SEARCH_H_INCLUDED

#include <vector>

#include "misc.h"
#include "movepick.h"
#include "types.h"

namespace Stockfish {

class Position;

namespace Search {

/// Threshold used for countermoves based pruning
constexpr int CounterMovePruneThreshold = 0;


/// Stack struct keeps track of the information we need to remember from nodes
/// shallower and deeper in the tree during the search. Each search thread has
/// its own array of Stack objects, indexed by the current ply.

struct Stack {
  Move* pv;
  PieceToHistory* continuationHistory;
  int ply;
  Move currentMove;
  Move excludedMove;
  Move killers[2];
  Value staticEval;
  int statScore;
  int moveCount;
  bool inCheck;
  bool ttPv;
  bool ttHit;
  int doubleExtensions;
};


/// RootMove struct is used for moves at the root of the tree. For each root move
/// we store a score and a PV (really a refutation in the case of moves which
/// fail low). Score is normally set at -VALUE_INFINITE for all non-pv moves.

struct RootMove {

  explicit RootMove(Move m) : pv(1, m) {}
  bool extract_ponder_from_tt(Position& pos);
  bool operator==(const Move& m) const { return pv[0] == m; }
  bool operator<(const RootMove& m) const { // Sort in descending order
    return m.score != score ? m.score < score
                            : m.previousScore < previousScore;
  }

  Value score = -VALUE_INFINITE;
  Value previousScore = -VALUE_INFINITE;
  int selDepth = 0;
  int tbRank = 0;
  Value tbScore;
  std::vector<Move> pv;
};

typedef std::vector<RootMove> RootMoves;


/// LimitsType struct stores information sent by GUI about available time to
/// search the current move, maximum depth/time, or if we are in analysis mode.

struct LimitsType {

  LimitsType() { // Init explicitly due to broken value-initialization of non POD in MSVC
    time[WHITE] = time[BLACK] = inc[WHITE] = inc[BLACK] = npmsec = movetime = TimePoint(0);
    movestogo = depth = mate = perft = infinite = 0;
    nodes = 0;
  }

  bool use_time_management() const {
    return time[WHITE] || time[BLACK];
  }

  std::vector<Move> searchmoves, banmoves;
  TimePoint time[COLOR_NB], inc[COLOR_NB], npmsec, movetime, startTime;
  int movestogo, depth, mate, perft, infinite;
  int64_t nodes;
};

extern LimitsType Limits;

struct SearchStats {
  bool active = false;

  enum OrderingPieceCategory {
    ORDERING_CANNON,
    ORDERING_ROOK,
    ORDERING_HORSE,
    ORDERING_ELEPHANT,
    ORDERING_PAWN,
    ORDERING_KING_ADVISOR,
    ORDERING_OTHER,
    ORDERING_PIECE_NB
  };

  enum OrderingFailHighBucket {
    ORDERING_FH_1,
    ORDERING_FH_2,
    ORDERING_FH_3_4,
    ORDERING_FH_5_8,
    ORDERING_FH_9_16,
    ORDERING_FH_17_PLUS,
    ORDERING_FH_BUCKET_NB
  };

  enum OrderingCheckCategory {
    ORDERING_CHECK_CANNON,
    ORDERING_CHECK_ROOK,
    ORDERING_CHECK_HORSE,
    ORDERING_CHECK_OTHER,
    ORDERING_CHECK_NB
  };

  struct OrderingPieceStats {
    uint64_t searched = 0;
    uint64_t moveIndexTotal = 0;
    uint64_t failHighs = 0;
    uint64_t alphaRaises = 0;
    int64_t alphaGainTotal = 0;
    uint64_t pvHeadAppearances = 0;
    uint64_t rootPvAppearances = 0;
    uint64_t ttMoveSearches = 0;
  };

  struct OrderingCheckStats {
    uint64_t seen = 0;
    uint64_t searched = 0;
    uint64_t failHighs = 0;
    uint64_t alphaRaises = 0;
    int64_t alphaGainTotal = 0;
    uint64_t pvAppearances = 0;
  };

  struct OrderingMoveKindStats {
    uint64_t searched = 0;
    uint64_t failHighs = 0;
    uint64_t pvAppearances = 0;
  };

  uint64_t orderingSearched = 0;
  uint64_t orderingFailHighs = 0;
  uint64_t orderingFirstMoveFailHighs = 0;
  uint64_t orderingFailHighIndexTotal = 0;
  uint64_t orderingFailHighBuckets[ORDERING_FH_BUCKET_NB] = {};
  uint64_t orderingTtMovePresent = 0;
  uint64_t orderingTtMoveSearched = 0;
  uint64_t orderingTtMoveFailHighs = 0;
  uint64_t orderingTtMoveAlphaRaises = 0;
  OrderingPieceStats orderingPieces[ORDERING_PIECE_NB];
  OrderingCheckStats orderingChecks;
  OrderingCheckStats orderingChecksByPiece[ORDERING_CHECK_NB];
  OrderingMoveKindStats orderingCaptures;
  OrderingMoveKindStats orderingQuiets;

  uint64_t childFutilityPrunes = 0;
  uint64_t nullMoveAttempts = 0;
  uint64_t nullMoveCutoffs = 0;
  uint64_t nullMoveVerifications = 0;
  uint64_t nullMoveVerificationCutoffs = 0;
  uint64_t probCutAttempts = 0;
  uint64_t probCutCandidates = 0;
  uint64_t probCutQsearchPasses = 0;
  uint64_t probCutSearchPasses = 0;
  uint64_t probCutCutoffs = 0;
  uint64_t inCheckProbCutCutoffs = 0;
  uint64_t mainMoveCountPruningActivations = 0;
  uint64_t mainCaptureHistoryPrunes = 0;
  uint64_t mainSeeCapturePrunes = 0;
  uint64_t mainContinuationPrunes = 0;
  uint64_t mainParentFutilityPrunes = 0;
  uint64_t mainSeeQuietPrunes = 0;
  uint64_t singularCandidates = 0;
  uint64_t singularSingleExtensions = 0;
  uint64_t singularDoubleExtensions = 0;
  uint64_t singularMultiCutCutoffs = 0;
  uint64_t singularBetaCutoffs = 0;
  uint64_t checkExtensionCandidates = 0;
  uint64_t checkExtensions = 0;
  uint64_t lmrCandidates = 0;
  uint64_t lmrApplied = 0;
  uint64_t lmrReductionTotal = 0;
  uint64_t lmrReducedFailHighs = 0;
  uint64_t lmrFullDepthSearches = 0;
  uint64_t lmrFullDepthFailHighs = 0;
  uint64_t qsearchStandPatCutoffs = 0;
  uint64_t qsearchMoveCountPrunes = 0;
  uint64_t qsearchFutilityPrunes = 0;
  uint64_t qsearchSeeFutilityPrunes = 0;
  uint64_t qsearchNegativeSeePrunes = 0;
  uint64_t qsearchContinuationPrunes = 0;
  uint64_t aspirationSearches = 0;
  uint64_t aspirationFailHighs = 0;
  uint64_t aspirationFailLows = 0;
  uint64_t aspirationResearches = 0;
  uint64_t aspirationMaxRetries = 0;

  void clear();
  void merge(const SearchStats& stats);
};

void init();
void clear();

} // namespace Search

} // namespace Stockfish

#endif // #ifndef SEARCH_H_INCLUDED
