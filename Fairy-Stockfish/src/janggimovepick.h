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

#ifndef MOVEPICK_H_INCLUDED
#define MOVEPICK_H_INCLUDED

#include <array>
#include <limits>
#include <type_traits>
#include <algorithm>
#include <cstdint>
#include <cassert>

#include "movegen.h"
#include "position.h"
#include "types.h"

namespace Stockfish {

template<typename T, int D>
class StatsEntry {
  T entry;

public:
  void operator=(const T& v) { entry = v; }
  T* operator&() { return &entry; }
  T* operator->() { return &entry; }
  operator const T&() const { return entry; }

  void operator<<(int bonus) {
    assert(std::abs(bonus) <= D);
    static_assert(D <= std::numeric_limits<T>::max(), "D overflows T");
    entry += bonus - entry * std::abs(bonus) / D;
    assert(std::abs(entry) <= D);
  }
};

template <typename T, int D, int Size, int... Sizes>
struct Stats : public std::array<Stats<T, D, Sizes...>, Size> {
  typedef Stats<T, D, Size, Sizes...> stats;
  void fill(const T& v) {
    assert(std::is_standard_layout<stats>::value);
    typedef StatsEntry<T, D> entry;
    entry* p = reinterpret_cast<entry*>(this);
    std::fill(p, p + sizeof(*this) / sizeof(entry), v);
  }
};

template <typename T, int D, int Size>
struct Stats<T, D, Size> : public std::array<StatsEntry<T, D>, Size> {};

enum StatsParams { NOT_USED = 0, PIECE_SLOTS = 8 };
enum StatsType { NoCaptures, Captures };

typedef Stats<int16_t, 13365, COLOR_NB, int(SQUARE_NB + 1) * int(1 << SQUARE_BITS)> ButterflyHistory;
typedef Stats<int16_t, 13365, COLOR_NB, SQUARE_NB> GateHistory;

constexpr int MAX_LPH = 4;
typedef Stats<int16_t, 10692, MAX_LPH, int(SQUARE_NB + 1) * int(1 << SQUARE_BITS)> LowPlyHistory;
typedef Stats<Move, NOT_USED, PIECE_NB, SQUARE_NB> CounterMoveHistory;
typedef Stats<int16_t, 10692, PIECE_NB, SQUARE_NB, PIECE_TYPE_NB> CapturePieceToHistory;
typedef Stats<int16_t, 29952, 2 * PIECE_SLOTS, SQUARE_NB> PieceToHistory;
typedef Stats<PieceToHistory, NOT_USED, 2 * PIECE_SLOTS, SQUARE_NB> ContinuationHistory;

int history_slot(Piece pc);

class MovePicker {
  enum PickType { Next, Best };

public:
  MovePicker(const MovePicker&) = delete;
  MovePicker& operator=(const MovePicker&) = delete;

  MovePicker(const Position&, Move, Value, const GateHistory*, const CapturePieceToHistory*);
  MovePicker(const Position&, Move, Depth, const ButterflyHistory*,
                                           const GateHistory*,
                                           const CapturePieceToHistory*,
                                           const PieceToHistory**,
                                           Square);
  MovePicker(const Position&, Move, Depth, const ButterflyHistory*,
                                           const GateHistory*,
                                           const LowPlyHistory*,
                                           const CapturePieceToHistory*,
                                           const PieceToHistory**,
                                           Move,
                                           const Move*,
                                           int);

  Move next_move(bool skipQuiets = false);

  ExtMove* begin() { return cur; }
  ExtMove* end() { return endMoves; }

private:
  template<PickType T, typename Pred> Move select(Pred);
  template<GenType> void score();

  const Position& pos;
  const ButterflyHistory* mainHistory;
  const GateHistory* gateHistory;
  const LowPlyHistory* lowPlyHistory;
  const CapturePieceToHistory* captureHistory;
  const PieceToHistory** continuationHistory;
  Move ttMove;
  ExtMove refutations[3];
  ExtMove *cur, *endMoves, *endBadCaptures;
  int stage;
  Square recaptureSquare;
  Value threshold;
  Depth depth;
  int ply;

  ExtMove moves[MAX_MOVES];
};

} // namespace Stockfish

#endif // #ifndef MOVEPICK_H_INCLUDED