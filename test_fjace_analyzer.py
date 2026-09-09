import unittest

from fjace_analyzer_all12 import (
    HistoryEntry,
    analyze_local_engine_correlation,
    calculate_partial_ai_probability,
)


def make_move(index, rank, loss, gap=50, entropy=1.5):
    return HistoryEntry(
        ply=index * 2, san="x", uci="a0a1", best_move="a0a1",
        top_3_moves=["a0a1", "b0b1", "c0c1"], is_top_1=rank == 1,
        is_top_3=rank <= 3, eval_loss=loss, current_eval=0,
        is_critical=gap < 150, is_forced=False, eval_gap=gap,
        game_id=0, entropy=entropy, is_top_5=rank <= 5,
        engine_rank=rank, cp_proximity=100.0,
    )


class LocalCorrelationCalibrationTests(unittest.TestCase):
    def test_five_move_perfect_professional_burst_is_not_assistance(self):
        moves = [
            make_move(i, 1 if 15 <= i < 20 or i % 2 == 0 else 2,
                      0 if 15 <= i < 20 else 15 + (i % 3) * 8)
            for i in range(45)
        ]
        result = analyze_local_engine_correlation(moves)
        self.assertGreaterEqual(result.raw_local_correlation, 70.0)
        self.assertLess(result.score, 60.0)
        self.assertLess(result.sample_reliability, 30.0)

    def test_twenty_move_elite_ambiguous_sequence_is_not_assistance(self):
        moves = []
        for i in range(60):
            if 20 <= i < 40:
                rank = 1 if i - 20 < 15 else (2 if i < 39 else 6)
                moves.append(make_move(i, rank, 3, gap=55))
            else:
                moves.append(make_move(i, 1 if i % 2 == 0 else 2,
                                       18 + (i % 4) * 5, gap=55))
        result = analyze_local_engine_correlation(moves)
        self.assertGreaterEqual(result.raw_local_correlation, 90.0)
        self.assertLess(result.score, 60.0)
        self.assertLess(result.position_information, 20.0)
        partial_score, _, _ = calculate_partial_ai_probability(moves)
        self.assertAlmostEqual(partial_score, result.score)

    def test_persistent_discriminating_partial_use_remains_detectable(self):
        moves = []
        for i in range(60):
            if 20 <= i < 40:
                moves.append(make_move(i, 1, 1, gap=140, entropy=0.35))
            else:
                moves.append(make_move(i, 1 if i % 5 == 0 else 6,
                                       45 + (i % 4) * 18, gap=120, entropy=0.60))
        result = analyze_local_engine_correlation(moves)
        self.assertGreaterEqual(result.score, 65.0)
        self.assertGreaterEqual(result.position_information, 60.0)
        self.assertGreaterEqual(result.persistence_score, 60.0)

    def test_repeated_top_two_tracking_remains_visible(self):
        moves = []
        for i in range(60):
            if 20 <= i < 40:
                moves.append(make_move(i, 2, 8, gap=120, entropy=0.50))
            else:
                moves.append(make_move(i, 1 if i % 5 == 0 else 6,
                                       45 + (i % 4) * 18, gap=120, entropy=0.60))
        result = analyze_local_engine_correlation(moves)
        self.assertGreaterEqual(result.engine_specific_choice, 75.0)
        self.assertGreaterEqual(result.score, 60.0)


if __name__ == "__main__":
    unittest.main()
