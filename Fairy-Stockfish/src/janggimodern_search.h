/*
  Fairy-Stockfish JanggiModern search support
*/

#ifndef JANGGIMODERN_SEARCH_H_INCLUDED
#define JANGGIMODERN_SEARCH_H_INCLUDED

#include "position.h"
#include "types.h"
#include "variant.h"

namespace Stockfish::JanggiModernSearch {

enum Role : int {
  Quiet = 0,
  Palace,
  KingLine,
  Cannon,
  LegPiece,
  Capture,
  Check,
  ROLE_NB
};

inline bool enabled(const Position& pos) {
  const Variant* v = pos.variant();
  return v->materialCounting == JANGGI_MATERIAL
      && !v->bikjangRule
      && v->moveRepetitionIllegal
      && v->nFoldRule == 4
      && v->nnueAlias == "janggi";
}

inline bool palace_geometry(const Position& pos, Square s) {
  return bool(pos.variant()->diagonalLines & s);
}

inline bool king_line_geometry(const Position& pos, Square s) {
  Square wk = pos.square<KING>(WHITE);
  Square bk = pos.square<KING>(BLACK);
  return file_of(s) == file_of(wk) || file_of(s) == file_of(bk)
      || rank_of(s) == rank_of(wk) || rank_of(s) == rank_of(bk);
}

inline Role role_of(const Position& pos, Move m, bool givesCheck) {
  if (!enabled(pos) || !is_ok(m))
      return Quiet;

  if (givesCheck)
      return Check;
  if (pos.capture_or_promotion(m))
      return Capture;

  Piece pc = pos.moved_piece(m);
  PieceType pt = type_of(pc);
  Square from = from_sq(m);
  Square to = to_sq(m);

  if (pt == JANGGI_CANNON)
      return Cannon;
  if (pt == HORSE || pt == JANGGI_ELEPHANT)
      return LegPiece;
  if (king_line_geometry(pos, from) || king_line_geometry(pos, to))
      return KingLine;
  if (palace_geometry(pos, from) || palace_geometry(pos, to))
      return Palace;

  return Quiet;
}

inline int reduction_bias(Role r) {
  // Bias is interpreted by the search as a history/reduction prior, not as a
  // direct move bonus. Forced/checking and geometry-changing move classes get
  // more history credit only after they prove useful through normal updates.
  switch (r)
  {
  case Check:    return 4096;
  case Capture:  return 2048;
  case Cannon:   return 1536;
  case LegPiece: return 1024;
  case KingLine: return 1024;
  case Palace:   return 512;
  default:       return 0;
  }
}

} // namespace Stockfish::JanggiModernSearch

#endif // JANGGIMODERN_SEARCH_H_INCLUDED
