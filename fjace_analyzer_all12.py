#!/usr/bin/env python3
"""FJACE Advanced Statistical Analyzer for Janggi.
[ 단일/다중 기보 하이브리드 AI 유사도 프로파일링 도구 - v12.3 ]
- MultiPV=5 실질 엔진 탑재 및 Top-1 -> Top-3 -> Top-5 선택 깔때기(Funnel) 추적
- 순위 볼록 감쇄(Convex Rank Decay) & CP 근접도(Proximity Decay) 평가 시스템
- 후보수 선택 분산도(Candidate Dispersion)를 통한 프로 기사 오탐(False-Positive) 정밀 방어
- 2D 경험적 LLR 순차 우도비(SPRT) 궤적 앙상블
- Ledoit-Wolf 적응형 수축 공분산 기반 Mahalanobis DB 클러스터링 보정
- MultiPV 섀넌 정책 엔트로피(Policy Entropy) 산출 및 승부처 CNAI 표본 게이팅 판독
- ASCII 형세 곡선 및 5/10/15/20/30/40수 다중 스케일 국지 상관 분석
- 모든 서술형 리포트, 용어 설명, 판독 가이드라인 100% 보존
"""

from __future__ import annotations

import argparse
import math
import re
import subprocess
import sys
import csv
import json
import time
import sqlite3
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# ==============================================================================
# DB 연동 및 성향 분석 / 라벨링 모듈 (Depth/Node 격리형 및 Move 보존형)
# ==============================================================================
DB_FILE = "janggi_profiles.db"

# ==============================================================================
# [실증 2D 비모수 LLR 표 & Ledoit-Wolf 공분산 엔진]
# ==============================================================================
GAP_BIN_EDGES = [30, 60, 120]
LOSS_BIN_EDGES = [0, 15, 60, 150]

EMPIRICAL_LLR_TABLE = [
    # Gap <= 30 cp (초난전/분기점)
    # Loss=0,    1~15cp,   16~60cp,  61~150cp, 151~300cp
    [ +1.35,    +0.45,    -0.80,    -1.90,    -3.10 ],
    # Gap 31~60 cp (타이트한 국면)
    [ +1.10,    +0.35,    -0.65,    -1.75,    -3.00 ],
    # Gap 61~120 cp (보통 국면)
    [ +0.60,    +0.15,    -0.40,    -1.45,    -2.70 ],
    # Gap > 120 cp (외길/단순 교환)
    [ +0.15,    +0.05,    -0.20,    -0.85,    -2.00 ]
]

def get_empirical_binned_llr(eval_gap: int, eval_loss: int) -> float:
    """2차원 격자 구간 검색을 통한 안정적인 비모수 LLR 값 반환"""
    g_idx = 0
    while g_idx < len(GAP_BIN_EDGES) and eval_gap > GAP_BIN_EDGES[g_idx]:
        g_idx += 1
        
    if eval_loss == 0:
        l_idx = 0
    else:
        l_idx = 1
        while l_idx < len(LOSS_BIN_EDGES) and eval_loss > LOSS_BIN_EDGES[l_idx]:
            l_idx += 1
            
    return EMPIRICAL_LLR_TABLE[g_idx][l_idx]

def compute_softmax_entropy(scores: List[int], temperature: float = 65.0) -> float:
    """MultiPV 후보수 평가치 분포로부터 섀넌 정책 엔트로피 산출"""
    if not scores or len(scores) < 2:
        return 0.0
    max_s = max(scores)
    exp_scores = [math.exp((s - max_s) / temperature) for s in scores]
    sum_exp = sum(exp_scores)
    if sum_exp <= 0.0:
        return 0.0
    probs = [e / sum_exp for e in exp_scores]
    return -sum(p * math.log(p + 1e-12) for p in probs)

def estimate_ledoit_wolf_covariance(samples: List[Tuple[float, float, float]]) -> List[List[float]]:
    """DB 표본으로부터 Ledoit-Wolf 수축 공분산 행렬 계산"""
    n = len(samples)
    if n < 4:
        return [
            [100.0, -45.0,  25.0],
            [-45.0, 110.0, -20.0],
            [ 25.0, -20.0,  70.0]
        ]
    p = 3
    means = [sum(s[j] for s in samples) / n for j in range(p)]
    S = [[0.0 for _ in range(p)] for _ in range(p)]
    for s in samples:
        diff = [s[j] - means[j] for j in range(p)]
        for i in range(p):
            for j in range(p):
                S[i][j] += diff[i] * diff[j]
    for i in range(p):
        for j in range(p):
            S[i][j] /= (n - 1)
    mu_var = sum(S[i][i] for i in range(p)) / p
    F = [[mu_var if i == j else 0.0 for j in range(p)] for i in range(p)]
    delta = min(1.0, max(0.05, 3.0 / (n + 2.0)))
    return [[(1.0 - delta) * S[i][j] + delta * F[i][j] for j in range(p)] for i in range(p)]

def invert_3x3_matrix(m: List[List[float]]) -> List[List[float]]:
    det = (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )
    if abs(det) < 1e-6:
        return [[1.0 / 100.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    invdet = 1.0 / det
    return [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invdet,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invdet,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invdet,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invdet,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invdet,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invdet,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invdet,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invdet,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invdet,
        ],
    ]

LIGROUND_GAMESEQ_PREFIX = "LIGROUND-GAMESEQ/"

def is_pass_token(token: str) -> bool:
    return token.strip().upper() in {"PASS", "--", "0000"}

def liground_uci_to_analyzer_uci(move: str) -> str:
    token = move.strip()
    if is_pass_token(token):
        return "0000"
    m = re.fullmatch(r"([a-i])(10|[1-9])([a-i])(10|[1-9])", token.lower())
    if not m:
        return token
    if m.group(1) == m.group(3) and m.group(2) == m.group(4):
        return "0000"
    return f"{m.group(1)}{int(m.group(2)) - 1}{m.group(3)}{int(m.group(4)) - 1}"

def parse_liground_game_sequence(text: str) -> Optional[Tuple[Optional[str], List[str]]]:
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines or not lines[0].startswith(LIGROUND_GAMESEQ_PREFIX):
        return None
    start_fen = None
    moves: List[str] = []
    in_moves = False
    for line in lines[1:]:
        if line.startswith("startFen:"):
            start_fen = line.replace("startFen:", "", 1).strip() or None
            in_moves = False
        elif line == "moves:":
            in_moves = True
        elif line == "meta:":
            in_moves = False
        elif line.startswith("variant:"):
            in_moves = False
        elif in_moves:
            move = re.sub(r"^\d+\.\s*", "", line).strip()
            if move:
                moves.append(liground_uci_to_analyzer_uci(move))
    return start_fen, moves

def get_search_config(depth: Optional[int], nodes: Optional[int]) -> str:
    if nodes: return f"N{nodes}"
    return f"D{depth}"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS players_v2 (
            nickname TEXT,
            search_config TEXT,
            total_games INTEGER DEFAULT 0,
            avg_acpl REAL DEFAULT 0,
            avg_top1 REAL DEFAULT 0,
            avg_blunder REAL DEFAULT 0,
            avg_std_dev REAL DEFAULT 0,
            primary_opening TEXT DEFAULT '분석중',
            playstyle TEXT DEFAULT '분석중',
            last_played TIMESTAMP,
            PRIMARY KEY (nickname, search_config)
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS labeled_stats_v2 (
            label_id INTEGER,
            search_config TEXT,
            label_name TEXT,
            count INTEGER DEFAULT 0,
            avg_acpl REAL DEFAULT 0.0,
            avg_top1 REAL DEFAULT 0.0,
            avg_std_dev REAL DEFAULT 0.0,
            PRIMARY KEY (label_id, search_config)
        )
    ''')
    # 상세 수순 캐싱용 테이블 구축 (Top-5, 순위, 근접도 완벽 보존)
    c.execute('''
        CREATE TABLE IF NOT EXISTS moves_v4 (
            game_hash TEXT,
            player_name TEXT,
            search_config TEXT,
            ply INTEGER,
            san TEXT,
            uci TEXT,
            best_move TEXT,
            is_top_1 INTEGER,
            is_top_3 INTEGER,
            is_top_5 INTEGER,
            engine_rank INTEGER,
            cp_proximity REAL,
            eval_loss INTEGER,
            current_eval INTEGER,
            is_critical INTEGER,
            is_forced INTEGER,
            eval_gap INTEGER,
            PRIMARY KEY (game_hash, player_name, search_config, ply)
        )
    ''')
    conn.commit()
    conn.close()

def detect_opening(uci_moves: List[str]) -> str:
    if len(uci_moves) < 2: return "기타/알수없음"
    moves_str = ",".join(uci_moves[:3])
    if "b0c2" in moves_str or "h0g2" in moves_str or "b9c7" in moves_str or "h9g7" in moves_str:
        if "c0e2" in moves_str or "g0e2" in moves_str or "c9e7" in moves_str or "g9e7" in moves_str:
            return "면상 (Myun-Sang)"
        return "귀마 (Gwi-ma)"
    elif "b0c2" in moves_str and "h0g2" in moves_str: return "원앙마 (Won-ang-ma)"
    elif "b0d2" in moves_str or "h0f2" in moves_str: return "양귀마 (Yang-gwi-ma)"
    return "변칙/동네장기"

def update_player_profile(nickname: str, stats: tuple, uci_moves: List[str], search_config: str):
    if not nickname or nickname == "-" or nickname.lower().startswith("player"): return
    acpl, top1, top3, top5, perf, inacc, mist, blunder, std_dev, crit_top1, u_top1, u_acpl = stats[:12]
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT * FROM players_v2 WHERE nickname = ? AND search_config = ?", (nickname, search_config))
    row = c.fetchone()
    now = datetime.datetime.now()
    opening = detect_opening(uci_moves)
    
    if row is None:
        style = "안정적 수비형" if std_dev < 25 else "난전/기복형"
        c.execute('''INSERT INTO players_v2 (nickname, search_config, total_games, avg_acpl, avg_top1, avg_blunder, avg_std_dev, primary_opening, playstyle, last_played)
                     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)''', (nickname, search_config, u_acpl, u_top1, blunder, std_dev, opening, style, now))
        print(f" [DB 저장 완료] '{nickname}'의 신규 프로필이 생성되었습니다. (기준: {search_config})")
    else:
        tg = row[2] + 1
        new_acpl = ((row[3] * row[2]) + u_acpl) / tg
        new_top1 = ((row[4] * row[2]) + u_top1) / tg
        new_blun = ((row[5] * row[2]) + blunder) / tg
        new_std  = ((row[6] * row[2]) + std_dev) / tg
        
        style = "다재다능"
        if new_std > 35 and new_blun > 2: style = "공격/기복형 (Aggressive/Inconsistent)"
        elif new_std < 22 and new_blun < 1: style = "견고한 수비형 (Solid/Defensive)"
        elif new_top1 > 55 and new_acpl < 25: style = "정통파 고수 (Orthodox Expert)"
        
        c.execute('''UPDATE players_v2 SET total_games=?, avg_acpl=?, avg_top1=?, avg_blunder=?, avg_std_dev=?, playstyle=?, last_played=? 
                     WHERE nickname=? AND search_config=?''', 
                  (tg, new_acpl, new_top1, new_blun, new_std, style, now, nickname, search_config))
        print(f" [DB 저장 완료] '{nickname}'의 누적 프로필이 업데이트 되었습니다. (총 {tg}판 / 기준: {search_config})")
    conn.commit()
    conn.close()

def update_labeled_stats(label_id: int, label_name: str, stats: tuple, search_config: str):
    acpl, top1, top3, top5, perf, inacc, mist, blunder, std_dev, crit_top1, u_top1, u_acpl = stats[:12]
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT count, avg_acpl, avg_top1, avg_std_dev FROM labeled_stats_v2 WHERE label_id = ? AND search_config = ?", (label_id, search_config))
    row = c.fetchone()
    
    if row:
        cnt, a_acpl, a_top1, a_std = row
        new_cnt = cnt + 1
        new_acpl = ((a_acpl * cnt) + u_acpl) / new_cnt
        new_top1 = ((a_top1 * cnt) + u_top1) / new_cnt
        new_std = ((a_std * cnt) + std_dev) / new_cnt
        c.execute("UPDATE labeled_stats_v2 SET count=?, avg_acpl=?, avg_top1=?, avg_std_dev=? WHERE label_id=? AND search_config=?", 
                  (new_cnt, new_acpl, new_top1, new_std, label_id, search_config))
        print(f" [DB 라벨링 누적] '{label_name}' 통계가 갱신되었습니다. (총 {new_cnt}건 / 기준: {search_config})")
    else:
        c.execute('''INSERT INTO labeled_stats_v2 (label_id, search_config, label_name, count, avg_acpl, avg_top1, avg_std_dev)
                     VALUES (?, ?, ?, 1, ?, ?, ?)''', (label_id, search_config, label_name, u_acpl, u_top1, std_dev))
        print(f" [DB 라벨링 생성] '{label_name}' 그룹이 신규 생성되었습니다. (기준: {search_config})")
        
    conn.commit()
    conn.close()

def extract_player_names(pgn_text: str) -> Tuple[str, str]:
    w_match = re.search(r'\[White "([^"]+)"\]', pgn_text)
    b_match = re.search(r'\[Black "([^"]+)"\]', pgn_text)
    white = w_match.group(1) if w_match and w_match.group(1) != "-" else ""
    black = b_match.group(1) if b_match and b_match.group(1) != "-" else ""
    return white, black

def calibrate_with_db(nickname: str, base_prob: float, base_part_prob: float, stats: tuple, use_db: bool, search_config: str) -> Tuple[float, float, str]:
    """[Ledoit-Wolf 적응형 Mahalanobis 보정 엔진]"""
    if not use_db: return base_prob, base_part_prob, ""
    
    acpl, top1, top3, top5, perf, inacc, mist, blunder, std_dev, crit_top1, u_top1, u_acpl = stats[:12]
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    
    c.execute("SELECT avg_acpl, avg_top1, avg_std_dev FROM labeled_stats_v2 WHERE search_config=?", (search_config,))
    sample_rows = c.fetchall()
    
    valid_samples = [(r[0], r[1], r[2]) for r in sample_rows if r[0] is not None]
    cov_matrix = estimate_ledoit_wolf_covariance(valid_samples)
    inv_cov = invert_3x3_matrix(cov_matrix)
    
    def calc_mahalanobis(v1: Tuple[float, float, float], v2: Tuple[float, float, float]) -> float:
        diff = [v1[0] - v2[0], v1[1] - v2[1], v1[2] - v2[2]]
        d_sq = sum(diff[i] * inv_cov[i][j] * diff[j] for i in range(3) for j in range(3))
        return math.sqrt(max(0.0, d_sq))

    c.execute("SELECT label_id, label_name, count, avg_acpl, avg_top1, avg_std_dev FROM labeled_stats_v2 WHERE count >= 1 AND search_config=?", (search_config,))
    labels = c.fetchall()
    
    new_prob = base_prob
    new_part_prob = base_part_prob
    msg = ""

    if labels:
        obs_vec = (u_acpl, u_top1, std_dev)
        min_dist = 9999.0
        closest_label_id = None
        closest_name = ""
        total_labeled_games = sum(row[2] for row in labels)

        for l_id, l_name, l_count, l_acpl, l_top1, l_std in labels:
            dist = calc_mahalanobis(obs_vec, (l_acpl, l_top1, l_std))
            if dist < min_dist:
                min_dist = dist
                closest_label_id = l_id
                closest_name = l_name

        data_weight = min(1.0, total_labeled_games / 4.0)
        dist_weight = max(0.0, 1.0 - (min_dist / 2.5))
        db_influence = math.sqrt(data_weight * dist_weight)

        target_probs = {
            1: 95.0,  # 기계적 의심 높음
            2: 75.0,  # 기계적 의심 보통
            3: 25.0,  # 사람 추정
            4:  5.0   # 사람 확신
        }
        
        if closest_label_id in target_probs and db_influence > 0.05:
            db_target = target_probs[closest_label_id]
            new_prob = (base_prob * (1.0 - db_influence)) + (db_target * db_influence)
            
            if closest_label_id in (3, 4): 
                new_part_prob = (base_part_prob * (1.0 - db_influence)) + (target_probs[closest_label_id] * db_influence)
            elif closest_label_id == 1:
                new_part_prob = max(base_part_prob, (base_part_prob * (1.0 - db_influence)) + (95.0 * db_influence))

            msg += f" [DB패턴: '{closest_name}' (Mahalanobis={min_dist:.2f}, 신뢰도 {db_influence*100:.0f}% 적용)]"
        else:
            if min_dist >= 2.5:
                msg += f" [DB: 기존 라벨링 패턴과 거리가 멀어({min_dist:.2f}) 수학 공식을 유지함]"

    if nickname and nickname != "-" and not nickname.lower().startswith("player"):
        c.execute("SELECT total_games, avg_acpl, avg_std_dev FROM players_v2 WHERE nickname=? AND search_config=?", (nickname, search_config))
        row = c.fetchone()
        if row and row[0] >= 3: 
            hist_acpl = row[1]
            if hist_acpl - u_acpl > 15 and new_prob > 50:
                new_prob = min(99.9, new_prob + 10.0)
                new_part_prob = min(99.9, new_part_prob + 10.0)
                msg += f" [!개인DB: 평소 실력 대비 극단적 성능 급등]"

    conn.close()
    return min(99.9, max(0.0, new_prob)), min(99.9, max(0.0, new_part_prob)), msg

def get_playstyle_narrative(nickname: str, search_config: str, current_moves: List[HistoryEntry]) -> str:
    if not nickname or nickname == "-" or nickname.lower().startswith("player"):
        stats = calc_stats(current_moves)
        std_dev, blunder = stats[8], stats[7]
        narrative = " 닉네임이 지정되지 않아 금일 1판의 대국에 국한된 단기 성향입니다.\n"
        if std_dev > 35 and blunder >= 2:
            narrative += "   👉 이 대국에서는 큰 난전과 전투가 벌어졌으며, 공격적이나 기복과 치명적 실수가 관찰되는 다이나믹한 흐름이었습니다."
        elif std_dev < 20 and blunder == 0:
            narrative += "   👉 이 대국에서는 수비적이고 매우 단단한 수읽기를 통해 기복 없이 안정적인(Solid) 방어 성향을 보여주었습니다."
        else:
            narrative += "   👉 전반적으로 공격과 수비의 밸런스가 맞춰진 일반적인 대국 전개 성향을 보여주었습니다."
        return narrative

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT total_games, avg_acpl, avg_top1, avg_blunder, avg_std_dev, primary_opening, playstyle FROM players_v2 WHERE nickname=? AND search_config=?", (nickname, search_config))
    row = c.fetchone()
    conn.close()

    if not row: return " 아직 DB에 데이터가 충분히 쌓이지 않아 상세 성향 파악이 대기 중입니다."
    
    t_games, a_acpl, a_top1, a_blun, a_std, opening, style = row
    reliability = "신뢰도 낮음"
    if t_games >= 10: reliability = "신뢰도 매우 높음 (성향 뚜렷함)"
    elif t_games >= 3: reliability = "신뢰도 보통 (데이터 누적 중)"

    narrative = f" 총 {t_games}판의 누적 데이터를 기반으로 분석한 결과 ({reliability}):\n"
    narrative += f"   👉 주로 [{opening}] 포진을 선호하며, 전반적인 대국 흐름은 [{style}]에 가깝습니다.\n"
    
    if a_std < 22:
        narrative += f"   👉 평균 기복(편차)이 {a_std:.1f}로 매우 낮아, 변칙적인 공격보다는 튼튼하게 진영을 갖추는 방어적이고 안정적인 운영을 선호합니다. "
    elif a_std > 35:
        narrative += f"   👉 평균 기복(편차)이 {a_std:.1f}로 높은 편으로, 수비보다는 난전을 유도하여 승부를 보는 공격적 성향이 강합니다. "
    else:
        narrative += f"   👉 평균 기복(편차)이 {a_std:.1f} 수준으로, 공수의 밸런스를 유연하게 가져가는 다재다능한 스타일입니다. "

    if a_blun < 0.5:
        narrative += f"특히 매 판 치명적 실수(Blunder)가 평균 {a_blun:.1f}회에 불과할 정도로 꼼꼼한 수읽기를 자랑합니다."
    elif a_blun > 2.0:
        narrative += f"다만 난전 속에서 치명적 실수(Blunder)가 평균 {a_blun:.1f}회씩 발생하여, 후반 집중력 보완이 필요해 보입니다."
        
    return narrative

# ==============================================================================
# 보드 및 엔진 제어부 (MultiPV=5 확장)
# ==============================================================================
FILES = "abcdefghi"
BOARD_FILES = range(9)
BOARD_RANKS = range(10)

MOVE_RE = re.compile(r"^([RHEACKP]?)([a-i0-9]{0,2})([a-i])(10|[0-9])$")

@dataclass
class EngineMoveInfo:
    uci: str
    score: int

@dataclass
class HistoryEntry:
    ply: int
    san: str
    uci: str
    best_move: str
    top_3_moves: List[str]
    is_top_1: bool
    is_top_3: bool
    eval_loss: int
    current_eval: int
    is_critical: bool
    is_forced: bool
    eval_gap: int
    start_fen: Optional[str] = None
    uci_history: List[str] = None
    game_id: int = 0
    stability: float = 0.0
    entropy: float = 0.0
    top_5_moves: List[str] = field(default_factory=list)
    is_top_5: bool = False
    engine_rank: int = 6       # 1~5: 순위 내, 6: 6위 이하(Off-PV)
    cp_proximity: float = 0.0  # 0~100% 지수 감쇄 근접도 점수

    def to_dict(self) -> dict:
        return {
            "ply": self.ply,
            "san": self.san,
            "uci": self.uci,
            "best_move": self.best_move,
            "is_top_1": self.is_top_1,
            "is_top_3": self.is_top_3,
            "is_top_5": self.is_top_5,
            "engine_rank": self.engine_rank,
            "cp_proximity": self.cp_proximity,
            "eval_loss": self.eval_loss,
            "current_eval": self.current_eval,
            "is_critical": self.is_critical,
            "is_forced": self.is_forced,
            "eval_gap": self.eval_gap,
            "stability": self.stability,
            "entropy": self.entropy
        }

@dataclass
class TacticalBurstResult:
    score: float
    start_ply: int
    end_ply: int
    game_id: int
    move_count: int
    acpl: float
    rank_match: float
    top1_rate: float
    std_dev: float
    baseline_acpl: float
    baseline_rank: float
    hard_count: int
    swing_count: int
    recovery_count: int
    transition_score: float
    safe_continuations: int
    island_count: int
    commentary: str

def to_fs_uci(uci_0: str) -> str:
    m = re.match(r"^([a-i])(\d+)([a-i])(\d+)$", uci_0)
    if m: return f"{m.group(1)}{int(m.group(2))+1}{m.group(3)}{int(m.group(4))+1}"
    return uci_0

def from_fs_uci(uci_fs: str) -> str:
    m = re.match(r"^([a-i])(\d+)([a-i])(\d+)$", uci_fs)
    if m: return f"{m.group(1)}{int(m.group(2))-1}{m.group(3)}{int(m.group(4))-1}"
    return uci_fs

def cap_score(score: int) -> int:
    return max(-3000, min(3000, score))

@dataclass(frozen=True)
class Piece:
    color: str
    kind: str

class JanggiBoard:
    def __init__(self) -> None:
        self.board: Dict[Tuple[int, int], Piece] = {}
        self._initial_color = "w"
        self._setup_initial_position()

    def load_fen(self, fen: str) -> None:
        self.board.clear()
        parts = fen.split()
        rows = parts[0].split('/')
        for rank_idx, row in enumerate(rows):
            rank = 9 - rank_idx
            file_idx = 0
            for char in row:
                if char.isdigit(): file_idx += int(char)
                else:
                    raw_kind = char.upper()
                    if raw_kind == "N": kind = "H"
                    elif raw_kind == "B": kind = "E"
                    else: kind = raw_kind
                    self.board[(file_idx, rank)] = Piece("w" if char.isupper() else "b", kind)
                    file_idx += 1
        if len(parts) > 1: self._initial_color = parts[1]

    def get_fen(self, ply_index: int) -> str:
        fen_rows = []
        for rank in range(9, -1, -1):
            empty_count = 0
            row_str = ""
            for file in range(9):
                piece = self.piece_at((file, rank))
                if piece is None:
                    empty_count += 1
                else:
                    if empty_count > 0:
                        row_str += str(empty_count)
                        empty_count = 0
                    raw_kind = piece.kind
                    if raw_kind == "H": kind = "N"
                    elif raw_kind == "E": kind = "B"
                    else: kind = raw_kind
                    char = kind.upper() if piece.color == "w" else kind.lower()
                    row_str += char
            if empty_count > 0:
                row_str += str(empty_count)
            fen_rows.append(row_str)
        
        fen_board = "/".join(fen_rows)
        active_color = self.side_to_move(ply_index)
        return f"{fen_board} {active_color} - - 0 1"

    @staticmethod
    def parse_square(text: str) -> Tuple[int, int]: return FILES.index(text[0].lower()), int(text[1:])
    @staticmethod
    def in_bounds(square: Tuple[int, int]) -> bool: return square[0] in BOARD_FILES and square[1] in BOARD_RANKS

    def _place(self, sq: str, color: str, kind: str) -> None: self.board[self.parse_square(sq)] = Piece(color, kind)
    def _setup_initial_position(self) -> None:
        for sq, kind in {"a0":"R","b0":"H","c0":"E","d0":"A","e1":"K","f0":"A","g0":"E","h0":"H","i0":"R","b2":"C","h2":"C","a3":"P","c3":"P","e3":"P","g3":"P","i3":"P"}.items(): self._place(sq, "w", kind)
        for sq, kind in {"a9":"R","b9":"H","c9":"E","d9":"A","e8":"K","f9":"A","g9":"E","h9":"H","i9":"R","b7":"C","h7":"C","a6":"P","c6":"P","e6":"P","g6":"P","i6":"P"}.items(): self._place(sq, "b", kind)

    def piece_at(self, square: Tuple[int, int]) -> Optional[Piece]: return self.board.get(square)
    def side_to_move(self, ply_index: int) -> str:
        base = 0 if self._initial_color == "w" else 1
        return "w" if (ply_index + base) % 2 == 0 else "b"

    def legal_moves_for_piece(self, origin: Tuple[int, int]) -> Iterable[Tuple[int, int]]:
        piece = self.board.get(origin)
        if not piece: return []
        if piece.kind == "R": yield from self._sliding_moves(origin, piece, True, True)
        elif piece.kind == "C": yield from self._cannon_moves(origin, piece)
        elif piece.kind == "H": yield from self._horse_moves(origin, piece)
        elif piece.kind == "E": yield from self._elephant_moves(origin, piece)
        elif piece.kind in ("A", "K"): yield from self._advisor_king_moves(origin, piece)
        elif piece.kind == "P": yield from self._pawn_moves(origin, piece)

    def _sliding_moves(self, origin, piece, orth, diag):
        if orth:
            for df, dr in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
                f, r = origin
                while True:
                    f += df; r += dr; sq = (f, r)
                    if not self.in_bounds(sq): break
                    blocker = self.piece_at(sq)
                    if blocker is None: yield sq; continue
                    if blocker.color != piece.color: yield sq
                    break
        if diag: yield from self._palace_diagonal_steps(origin, piece)

    def _cannon_moves(self, origin, piece):
        for df, dr in [(1, 0), (-1, 0), (0, 1), (0, -1)]:
            f, r = origin; jumped = False
            while True:
                f += df; r += dr; sq = (f, r)
                if not self.in_bounds(sq): break
                blocker = self.piece_at(sq)
                if not jumped:
                    if blocker is None: continue
                    if blocker.kind == "C": break
                    jumped = True; continue
                if blocker is None: yield sq; continue
                if blocker.color != piece.color and blocker.kind != "C": yield sq
                break
        palaces = [((4, 1), {(3, 0): (5, 2), (5, 0): (3, 2), (3, 2): (5, 0), (5, 2): (3, 0)}), ((4, 8), {(3, 7): (5, 9), (5, 7): (3, 9), (3, 9): (5, 7), (5, 9): (3, 7)})]
        for center, corners in palaces:
            if origin in corners:
                dest = corners[origin]
                c_piece = self.piece_at(center)
                if c_piece is not None and c_piece.kind != "C":
                    d_piece = self.piece_at(dest)
                    if d_piece is None or (d_piece.color != piece.color and d_piece.kind != "C"): yield dest

    def _horse_moves(self, origin, piece):
        for leg, dest_delta in [((0,1),(-1,2)), ((0,1),(1,2)), ((0,-1),(-1,-2)), ((0,-1),(1,-2)), ((1,0),(2,-1)), ((1,0),(2,1)), ((-1,0),(-2,-1)), ((-1,0),(-2,1))]:
            leg_sq = (origin[0]+leg[0], origin[1]+leg[1])
            dest = (origin[0]+dest_delta[0], origin[1]+dest_delta[1])
            if not self.in_bounds(dest) or self.piece_at(leg_sq) is not None: continue
            blocker = self.piece_at(dest)
            if blocker is None or blocker.color != piece.color: yield dest

    def _elephant_moves(self, origin, piece):
        for l1, l2_d, dest_d in [((0,1),(-1,2),(-2,3)), ((0,1),(1,2),(2,3)), ((0,-1),(-1,-2),(-2,-3)), ((0,-1),(1,-2),(2,-3)), ((1,0),(2,-1),(3,-2)), ((1,0),(2,1),(3,2)), ((-1,0),(-2,-1),(-3,-2)), ((-1,0),(-2,1),(-3,2))]:
            l1_sq = (origin[0]+l1[0], origin[1]+l1[1])
            l2_sq = (origin[0]+l2_d[0], origin[1]+l2_d[1])
            dest = (origin[0]+dest_d[0], origin[1]+dest_d[1])
            if not self.in_bounds(dest): continue
            if self.piece_at(l1_sq) is not None or self.piece_at(l2_sq) is not None: continue
            blocker = self.piece_at(dest)
            if blocker is None or blocker.color != piece.color: yield dest

    def _advisor_king_moves(self, origin, piece):
        moves = [(origin[0]+1, origin[1]), (origin[0]-1, origin[1]), (origin[0], origin[1]+1), (origin[0], origin[1]-1)]
        if origin in ((3, 0), (5, 0), (3, 2), (5, 2)): moves.append((4, 1))
        elif origin == (4, 1): moves.extend([(3, 0), (5, 0), (3, 2), (5, 2)])
        if origin in ((3, 7), (5, 7), (3, 9), (5, 9)): moves.append((4, 8))
        elif origin == (4, 8): moves.extend([(3, 7), (5, 7), (3, 9), (5, 9)])
        for dest in moves:
            if not self._in_palace(dest, piece.color): continue
            blocker = self.piece_at(dest)
            if blocker is None or blocker.color != piece.color: yield dest

    def _pawn_moves(self, origin, piece):
        dir = 1 if piece.color == "w" else -1
        moves = [(origin[0], origin[1]+dir), (origin[0]-1, origin[1]), (origin[0]+1, origin[1])]
        if piece.color == "w":
            if origin in ((3, 7), (5, 7)): moves.append((4, 8))
            elif origin == (4, 8): moves.extend([(3, 9), (5, 9)])
        else:
            if origin in ((3, 2), (5, 2)): moves.append((4, 1))
            elif origin == (4, 1): moves.extend([(3, 0), (5, 0)])
        for dest in moves:
            if not self.in_bounds(dest): continue
            blocker = self.piece_at(dest)
            if blocker is None or blocker.color != piece.color: yield dest

    def _palace_diagonal_steps(self, origin, piece):
        palaces = [((4, 1), [(3, 0), (5, 2)], [(5, 0), (3, 2)]), ((4, 8), [(3, 7), (5, 9)], [(5, 7), (3, 9)])]
        for center, diag1, diag2 in palaces:
            if origin == center:
                for dest in diag1 + diag2:
                    blocker = self.piece_at(dest)
                    if blocker is None or blocker.color != piece.color: yield dest
            else:
                for diag in (diag1, diag2):
                    if origin in diag:
                        blocker = self.piece_at(center)
                        if blocker is None or blocker.color != piece.color: yield center
                        if blocker is None:
                            opp = diag[1] if diag[0] == origin else diag[0]
                            opp_blocker = self.piece_at(opp)
                            if opp_blocker is None or opp_blocker.color != piece.color: yield opp

    def _in_palace(self, sq, color):
        return (3 <= sq[0] <= 5 and 0 <= sq[1] <= 2) if color == "w" else (3 <= sq[0] <= 5 and 7 <= sq[1] <= 9)

    def is_in_check(self, color: str) -> bool:
        king_sq = None
        for sq, p in self.board.items():
            if p.color == color and p.kind == "K":
                king_sq = sq
                break
        if not king_sq: return False

        opp_color = "b" if color == "w" else "w"
        opp_king_sq = None
        
        for sq, p in self.board.items():
            if p.color == opp_color:
                if p.kind == "K":
                    opp_king_sq = sq
                    continue
                if king_sq in self.legal_moves_for_piece(sq):
                    return True

        if opp_king_sq and king_sq[0] == opp_king_sq[0]:
            min_r = min(king_sq[1], opp_king_sq[1])
            max_r = max(king_sq[1], opp_king_sq[1])
            if not any((king_sq[0], r) in self.board for r in range(min_r + 1, max_r)):
                return True

        return False

    def move_to_uci(self, san: str, ply_index: int) -> str:
        san_clean = san.strip()
        if is_pass_token(san_clean):
            return "0000"
        uci_match = re.fullmatch(r"([a-i])([0-9])([a-i])([0-9])", san_clean.lower())
        if uci_match:
            if uci_match.group(1) == uci_match.group(3) and uci_match.group(2) == uci_match.group(4):
                return "0000"
            origin = self.parse_square(uci_match.group(1) + uci_match.group(2))
            dest = self.parse_square(uci_match.group(3) + uci_match.group(4))
            piece = self.piece_at(origin)
            if not piece or piece.color != self.side_to_move(ply_index) or dest not in self.legal_moves_for_piece(origin):
                raise ValueError(f"'{san}' (UCI move is not legal in the current position.)")
            self.board[dest] = self.board.pop(origin)
            return san_clean.lower()
            
        match = MOVE_RE.match(san_clean)
        if not match: raise ValueError(f"Unsupported move token: {san}")
        
        p_kind = match.group(1).upper() if match.group(1) else "P"
        origin_hint = match.group(2).lower() 
        color = self.side_to_move(ply_index)
        dest = self.parse_square(match.group(3) + match.group(4))

        candidates = []
        for square, piece in self.board.items():
            if piece.color == color and piece.kind == p_kind and dest in self.legal_moves_for_piece(square):
                candidates.append(square)

        if origin_hint:
            filtered = []
            for sq in candidates:
                f_char = FILES[sq[0]]
                r_char = str(sq[1])
                if origin_hint == f_char or origin_hint == r_char or origin_hint == f_char + r_char:
                    filtered.append(sq)
            if filtered: candidates = filtered

        if len(candidates) > 1:
            valid_candidates = []
            for sq in candidates:
                moved_piece = self.board.pop(sq)
                captured_piece = self.board.get(dest)
                self.board[dest] = moved_piece
                if not self.is_in_check(color):
                    valid_candidates.append(sq)
                self.board.pop(dest)
                self.board[sq] = moved_piece
                if captured_piece is not None:
                    self.board[dest] = captured_piece
            if valid_candidates: candidates = valid_candidates

        if len(candidates) > 1:
            if p_kind == "P" and not origin_hint:
                same_file = [sq for sq in candidates if sq[0] == dest[0]]
                if same_file: candidates = same_file

        if not candidates:
            raise ValueError(f"'{san}' (유효한 이동 기물이 없습니다.)")
        if len(candidates) > 1:
            raise ValueError(f"'{san}' (모호한 기보 수순입니다.)")
            
        origin = candidates[0]
        uci = f"{FILES[origin[0]]}{origin[1]}{FILES[dest[0]]}{dest[1]}"
        self.board[dest] = self.board.pop(origin)
        return uci

def parse_score(cp_str: str, mate_str: str) -> int:
    if cp_str: return int(cp_str)
    if mate_str:
        val = int(mate_str)
        return 10000 - val if val > 0 else -10000 - val
    return 0

class EngineSession:
    def __init__(self, engine_path: Path, depth: Optional[int], nodes: Optional[int], nnue_path: Optional[str] = None, use_nnue: bool = True, threads: int = 1) -> None:
        self.depth = depth
        self.nodes = nodes
        self.proc = subprocess.Popen([str(engine_path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.send("uci")
        self._wait_for("uciok")
        self.send("setoption name UCI_Variant value janggimodern")
        self.send("setoption name MultiPV value 5")  # [핵심] 5순위 수순 및 평가치 확보
        if threads > 1: self.send(f"setoption name Threads value {threads}")
        
        if use_nnue:
            if nnue_path:
                self.send(f"setoption name EvalFile value {nnue_path}")
            self.send("setoption name Use NNUE value true")
        else:
            self.send("setoption name Use NNUE value false")
            
        self.send("isready")
        self._wait_for("readyok")

    def send(self, line: str) -> None:
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except OSError:
            pass 

    def _wait_for(self, needle: str, timeout: float = 15.0) -> str:
        start_time = time.time()
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError(f"엔진 프로세스가 비정상 종료되었습니다. (대기열: {needle})")
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("엔진 통신 두절 (Engine Crashed)")
            if needle in line: 
                return line
            if time.time() - start_time > timeout:
                raise TimeoutError(f"엔진 응답 지연 (Timeout): '{needle}'")

    def get_top_moves(self, fen: str, timeout: float = 60.0) -> Tuple[List[EngineMoveInfo], int]:
        parts = fen.split()
        norm_fen = f"{parts[0]} {parts[1]} - - 0 1" if len(parts) >= 2 else fen
        cmd = f"position fen {norm_fen}"
            
        self.send(cmd)
        if self.nodes:
            self.send(f"go nodes {self.nodes}")
        else:
            self.send(f"go depth {self.depth}")

        # multipv 인덱스(1~5)별로 완벽 격리 수집하여 4~5순위 누락 방지
        mpv_table: Dict[int, EngineMoveInfo] = {}
        
        start_time = time.time()
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError("분석 중 엔진 프로세스가 비정상 종료되었습니다.")
            line = self.proc.stdout.readline()
            if not line: 
                raise RuntimeError("분석 중 엔진과의 연결이 끊어졌습니다. (Engine Crashed)")
            if time.time() - start_time > timeout:
                raise TimeoutError(f"엔진 탐색 시간 초과 ({timeout}초). 응답이 없습니다.")

            if "info" in line and "pv" in line and "score" in line:
                mpv_match = re.search(r"\bmultipv (\d+)\b", line)
                score_match = re.search(r"score (cp|mate) (-?\d+)", line)
                pv_match = re.search(r"pv\s+([a-i]\d+[a-i]\d+)", line)
                if score_match and pv_match:
                    mpv_idx = int(mpv_match.group(1)) if mpv_match else 1
                    stype, sval = score_match.group(1), score_match.group(2)
                    score = parse_score(sval if stype == "cp" else None, sval if stype == "mate" else None)
                    move_uci = from_fs_uci(pv_match.group(1))
                    mpv_table[mpv_idx] = EngineMoveInfo(move_uci, score)
                    
            if line.startswith("bestmove"):
                sorted_moves = [mpv_table[k] for k in sorted(mpv_table.keys())]
                top_5 = sorted_moves[:5]
                best_score = top_5[0].score if top_5 else 0
                return top_5, best_score

    def evaluate_specific_move(self, fen: str, target_move: str, timeout: float = 60.0) -> int:
        if target_move == "0000":
            return 0
            
        fs_target = to_fs_uci(target_move)
        parts = fen.split()
        norm_fen = f"{parts[0]} {parts[1]} - - 0 1" if len(parts) >= 2 else fen
        cmd = f"position fen {norm_fen}"
            
        self.send(cmd)
        if self.nodes:
            self.send(f"go nodes {self.nodes} searchmoves {fs_target}")
        else:
            self.send(f"go depth {self.depth} searchmoves {fs_target}")
        
        score = 0
        start_time = time.time()
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError("특정 수 평가 중 엔진 프로세스 종료")
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("특정 수 평가 중 엔진 통신 두절")
            if time.time() - start_time > timeout:
                raise TimeoutError(f"엔진 탐색 시간 초과 ({timeout}초)")
                
            if "info" in line and "score" in line:
                m = re.search(r"score (cp|mate) (-?\d+)", line)
                if m: score = parse_score(m.group(2) if m.group(1) == "cp" else None, m.group(2) if m.group(1) == "mate" else None)
            if line.startswith("bestmove"):
                return score

    def close(self) -> None:
        if self.proc.poll() is None:
            try: self.send("quit")
            except: pass
            self.proc.terminate()
            self.proc.wait(timeout=5)

def tokenize_pgn_moves(text: str) -> List[str]:
    liground = parse_liground_game_sequence(text)
    if liground is not None:
        return liground[1]
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = re.sub(r"\{[^}]*\}", " ", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    tokens = []
    for raw in text.replace("\n", " ").split():
        if raw in {"1-0", "0-1", "1/2-1/2", "*"}: continue
        if re.match(r"^\d+\.*$", raw): continue
        clean = raw.replace("x", "").replace("X", "").replace("+", "").replace("#", "")
        if clean: tokens.append(clean)
    return tokens

def get_difficulty_weight(eval_gap: int) -> float:
    if eval_gap <= 30: return 1.5
    if eval_gap <= 50: return 1.3
    if eval_gap >= 150: return 0.3
    return 1.0

def compute_game_hash(pgn_text: str) -> str:
    import hashlib
    clean = re.sub(r'\s+', '', pgn_text)
    return hashlib.md5(clean.encode('utf-8')).hexdigest()[:16]

def save_moves_to_db(game_hash: str, player_name: str, search_config: str, history: List[HistoryEntry]):
    if not player_name:
        return
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    for h in history:
        c.execute('''
            INSERT OR REPLACE INTO moves_v4 (
                game_hash, player_name, search_config, ply, san, uci,
                best_move, is_top_1, is_top_3, is_top_5, engine_rank, cp_proximity,
                eval_loss, current_eval, is_critical, is_forced, eval_gap
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            game_hash, player_name, search_config, h.ply, h.san, h.uci,
            h.best_move, 1 if h.is_top_1 else 0, 1 if h.is_top_3 else 0,
            1 if h.is_top_5 else 0, h.engine_rank, h.cp_proximity,
            h.eval_loss, h.current_eval, 1 if h.is_critical else 0,
            1 if h.is_forced else 0, h.eval_gap
        ))
    conn.commit()
    conn.close()

def get_cached_game_moves(game_hash: str, player_name: str, search_config: str) -> Optional[List[HistoryEntry]]:
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''
        SELECT ply, san, uci, best_move, is_top_1, is_top_3, is_top_5, engine_rank, cp_proximity,
               eval_loss, current_eval, is_critical, is_forced, eval_gap 
        FROM moves_v4 
        WHERE game_hash=? AND player_name=? AND search_config=?
        ORDER BY ply ASC
    ''', (game_hash, player_name, search_config))
    rows = c.fetchall()
    conn.close()
    if not rows:
        return None
    
    history = []
    for r in rows:
        history.append(HistoryEntry(
            ply=r[0], san=r[1], uci=r[2], best_move=r[3],
            top_3_moves=[r[3]], 
            is_top_1=bool(r[4]), is_top_3=bool(r[5]), is_top_5=bool(r[6]),
            engine_rank=r[7], cp_proximity=r[8],
            eval_loss=r[9], current_eval=r[10],
            is_critical=bool(r[11]), is_forced=bool(r[12]), eval_gap=r[13],
            entropy=0.0,
            top_5_moves=[r[3]]
        ))
    return history

def analyze_game(engine_path: Path, pgn_text: str, depth: Optional[int], nodes: Optional[int], nnue_path: Optional[str], aux_nnues: List[str], use_nnue: bool, threads: int, log_prefix: str = "", game_id: int = 0, force_reanalyze: bool = False, repeat: int = 1) -> List[HistoryEntry]:
    search_config = get_search_config(depth, nodes)
    game_hash = compute_game_hash(pgn_text)
    white_name, black_name = extract_player_names(pgn_text)
    
    db_white = white_name if (white_name and white_name != "-" and not white_name.lower().startswith("player")) else "Cho_Player"
    db_black = black_name if (black_name and black_name != "-" and not black_name.lower().startswith("player")) else "Han_Player"

    if not force_reanalyze:
        cached_moves_w = get_cached_game_moves(game_hash, db_white, search_config)
        cached_moves_b = get_cached_game_moves(game_hash, db_black, search_config)
        if cached_moves_w and cached_moves_b:
            print(f"{log_prefix} [DB Cache] 기분석 수순 로컬 DB 로드 완료.")
            total_cached = []
            for i in range(max(len(cached_moves_w), len(cached_moves_b))):
                if i < len(cached_moves_w):
                    cached_moves_w[i].game_id = game_id
                    total_cached.append(cached_moves_w[i])
                if i < len(cached_moves_b):
                    cached_moves_b[i].game_id = game_id
                    total_cached.append(cached_moves_b[i])
            return sorted(total_cached, key=lambda x: x.ply)

    all_runs = []
    for run_idx in range(repeat):
        run_prefix = f"{log_prefix}[Run {run_idx+1}/{repeat}] " if repeat > 1 else log_prefix
        board = JanggiBoard()
        engine = EngineSession(engine_path, depth, nodes, nnue_path, use_nnue, threads)
        
        aux_sessions = []
        if use_nnue and aux_nnues:
            print(f"{run_prefix}➔ AI 합의(Consensus) 패널 엔진 {len(aux_nnues)}개 가동 중...")
            for aux_path in aux_nnues[:2]: 
                aux_sessions.append(EngineSession(engine_path, depth, nodes, aux_path, True, max(1, threads // 2)))

        liground_sequence = parse_liground_game_sequence(pgn_text)
        fen_match = re.search(r'\[FEN\s+"([^"]+)"\]', pgn_text)
        start_fen = liground_sequence[0] if liground_sequence else (fen_match.group(1) if fen_match else None)
        if start_fen: board.load_fen(start_fen)

        tokens = tokenize_pgn_moves(pgn_text)
        uci_moves = []
        run_history = []
        
        search_type = f"{nodes} Nodes" if nodes else f"Depth {depth}"
        print(f"{run_prefix}총 {len(tokens)}수 정밀 분석({search_type}, MultiPV=5, 합의 패널 가동) 시작...")
        
        try:
            for ply, san in enumerate(tokens):
                current_fen = board.get_fen(ply)
                try:
                    actual_uci = board.move_to_uci(san, ply)
                except ValueError as e:
                    print(f"\n[Warning] 기보 인식 오류 ({san}) (Ply {ply+1}): {e}")
                    break
                    
                try:
                    top_moves, best_score = engine.get_top_moves(current_fen)
                    top_ucis = [m.uci for m in top_moves]
                    best_uci = top_ucis[0] if top_ucis else ""
                    
                    multi_scores = [m.score for m in top_moves]
                    entropy_val = compute_softmax_entropy(multi_scores)
                    
                    actual_score = None
                    if actual_uci == "0000":
                        next_fen = board.get_fen(ply + 1)
                        _, opp_best_score = engine.get_top_moves(next_fen)
                        actual_score = -opp_best_score
                    else:
                        for m in top_moves:
                            if m.uci == actual_uci:
                                actual_score = m.score
                                break
                        if actual_score is None:
                            actual_score = engine.evaluate_specific_move(current_fen, actual_uci)
                except (RuntimeError, TimeoutError) as e:
                    print(f"\n[Error] AI 엔진 오류: {e}")
                    break
                
                loss = max(0, cap_score(best_score) - cap_score(actual_score))
                loss = min(loss, 300)
                
                # 합의 패널 보정
                if loss >= 15 and actual_uci != best_uci and aux_sessions:
                    for aux_eng in aux_sessions:
                        aux_top, aux_best_score = aux_eng.get_top_moves(current_fen)
                        aux_top_ucis = [m.uci for m in aux_top]
                        if actual_uci in aux_top_ucis:
                            aux_actual = next((m.score for m in aux_top if m.uci == actual_uci), None)
                            if aux_actual is None: continue
                            aux_loss = max(0, cap_score(aux_best_score) - cap_score(aux_actual))
                            aux_loss = min(aux_loss, 300)
                            if aux_loss < loss:
                                loss = aux_loss
                                best_uci = aux_top_ucis[0] if aux_top_ucis else best_uci
                                actual_score = aux_actual
                                for u in aux_top_ucis:
                                    if u not in top_ucis: top_ucis.append(u)
                                if actual_uci == best_uci: break
                
                is_critical = False
                is_forced = False
                eval_gap = 9999
                
                if len(top_moves) >= 2:
                    eval_gap = abs(cap_score(top_moves[0].score) - cap_score(top_moves[1].score))
                    forced_threshold = 200 if ply >= 60 else 300
                    if eval_gap >= forced_threshold: is_forced = True
                    elif eval_gap < 150 and abs(cap_score(best_score)) < 1500: is_critical = True
                elif len(top_moves) == 1: is_forced = True

                # Top-5 및 순위 판별
                top_3_ucis = top_ucis[:3]
                top_5_ucis = top_ucis[:5]
                is_t1 = (actual_uci == best_uci)
                is_t3 = (actual_uci in top_3_ucis)
                is_t5 = (actual_uci in top_5_ucis)
                
                if actual_uci in top_5_ucis:
                    eng_rank = top_5_ucis.index(actual_uci) + 1
                    cp_prox = math.exp(-loss / 20.0) * 100.0
                else:
                    eng_rank = 6
                    cp_prox = math.exp(-loss / 15.0) * 20.0

                run_history.append(HistoryEntry(
                    ply=ply, san=san, uci=actual_uci,
                    best_move=best_uci, top_3_moves=top_3_ucis,
                    is_top_1=is_t1, is_top_3=is_t3,
                    eval_loss=loss, current_eval=actual_score,
                    is_critical=is_critical, is_forced=is_forced, eval_gap=eval_gap,
                    start_fen=current_fen, uci_history=list(uci_moves), game_id=game_id,
                    entropy=entropy_val,
                    top_5_moves=top_5_ucis,
                    is_top_5=is_t5,
                    engine_rank=eng_rank,
                    cp_proximity=cp_prox
                ))
                
                uci_moves.append(actual_uci)
                mark = "F" if is_forced else ("C" if is_critical else "N")
                rank_lbl = f"R{eng_rank}" if eng_rank <= 5 else "R6+"
                print(f"Analyzing... [{ply+1:03d}/{len(tokens):03d}] [실제: {actual_uci} | AI: {best_uci} | {rank_lbl} | Loss: {loss:3d}cp | {mark}]    ", end='\r')
                
        finally:
            print(f"\nAnalysis Complete.                            ")
            engine.close()
            for aux_eng in aux_sessions: aux_eng.close()
        all_runs.append(run_history)

    if repeat == 1:
        history = all_runs[0]
    else:
        min_len = min(len(r) for r in all_runs)
        history = []
        for p in range(min_len):
            entries = [all_runs[run_idx][p] for run_idx in range(repeat)]
            losses = [e.eval_loss for e in entries]
            mean_loss = sum(losses) / len(losses)
            variance = sum((x - mean_loss) ** 2 for x in losses) / (len(losses) - 1) if len(losses) > 1 else 0.0
            stdev_loss = math.sqrt(variance)

            sorted_with_indices = sorted(enumerate(losses), key=lambda x: x[1])
            median_run_idx = sorted_with_indices[len(sorted_with_indices) // 2][0]
            median_entry = entries[median_run_idx]

            history.append(HistoryEntry(
                ply=median_entry.ply,
                san=median_entry.san,
                uci=median_entry.uci,
                best_move=median_entry.best_move,
                top_3_moves=median_entry.top_3_moves,
                is_top_1=bool(sorted([1 if e.is_top_1 else 0 for e in entries])[len(entries) // 2]),
                is_top_3=bool(sorted([1 if e.is_top_3 else 0 for e in entries])[len(entries) // 2]),
                eval_loss=sorted(losses)[len(losses) // 2],
                current_eval=sorted([e.current_eval for e in entries])[len(entries) // 2],
                is_critical=bool(sorted([1 if e.is_critical else 0 for e in entries])[len(entries) // 2]),
                is_forced=bool(sorted([1 if e.is_forced else 0 for e in entries])[len(entries) // 2]),
                eval_gap=sorted([e.eval_gap for e in entries])[len(entries) // 2],
                start_fen=median_entry.start_fen,
                uci_history=median_entry.uci_history,
                game_id=median_entry.game_id,
                stability=stdev_loss,
                entropy=median_entry.entropy,
                top_5_moves=median_entry.top_5_moves,
                is_top_5=bool(sorted([1 if e.is_top_5 else 0 for e in entries])[len(entries) // 2]),
                engine_rank=median_entry.engine_rank,
                cp_proximity=median_entry.cp_proximity
            ))

    cho_moves = [h for h in history if h.ply % 2 == 0]
    han_moves = [h for h in history if h.ply % 2 != 0]
    save_moves_to_db(game_hash, db_white, search_config, cho_moves)
    save_moves_to_db(game_hash, db_black, search_config, han_moves)
    return history

def get_numeric_phase_acpl(moves, start_ply, end_ply):
    phase_moves = [m for m in moves if start_ply <= m.ply <= end_ply]
    if not phase_moves: return None
    return sum(m.eval_loss for m in phase_moves) / len(phase_moves)

def calc_stats(moves: List[HistoryEntry]):
    total = len(moves)
    if total == 0: return [0.0]*12
    
    losses = [m.eval_loss for m in moves]
    acpl = sum(losses) / total
    variance = sum((x - acpl) ** 2 for x in losses) / total
    std_dev = math.sqrt(variance)
    
    top1 = sum(1 for m in moves if m.is_top_1) / total * 100
    top3 = sum(1 for m in moves if m.is_top_3) / total * 100
    top5 = sum(1 for m in moves if m.is_top_5) / total * 100
    
    perfect = sum(1 for x in losses if x <= 5)
    inacc = sum(1 for x in losses if 50 <= x < 100)
    mistake = sum(1 for x in losses if 100 <= x < 200)
    blunder = sum(1 for x in losses if x >= 200)

    unforced = [m for m in moves if not m.is_forced]
    u_total = len(unforced)
    u_top1 = (sum(1 for m in unforced if m.is_top_1) / u_total * 100) if u_total > 0 else 0.0
    u_acpl = (sum(m.eval_loss for m in unforced) / u_total) if u_total > 0 else 0.0

    critical = [m for m in moves if m.is_critical]
    c_top1 = (sum(1 for m in critical if m.is_top_1) / len(critical) * 100) if critical else 0.0
    
    return acpl, top1, top3, top5, perfect, inacc, mistake, blunder, std_dev, c_top1, u_top1, u_acpl

def calc_advanced_stats(moves: List[HistoryEntry]) -> Tuple[Optional[float], Optional[float], Optional[float], int, Dict[str, float]]:
    unforced = [m for m in moves if not m.is_forced]
    mid_late_unforced = [m for m in unforced if m.ply >= 12]
    
    window_size = 10 
    min_window_acpl = None
    if len(mid_late_unforced) >= window_size:
        min_acpl = 999.0
        for i in range(len(mid_late_unforced) - window_size + 1):
            window = mid_late_unforced[i:i+window_size]
            w_acpl = sum(m.eval_loss for m in window) / window_size
            if w_acpl < min_acpl:
                min_acpl = w_acpl
        min_window_acpl = min_acpl

    hard_moves = [m for m in unforced if m.eval_gap <= 50 and abs(m.current_eval) < 1500]
    hard_count = len(hard_moves)
    hard_top1 = (sum(1 for m in hard_moves if m.is_top_1) / hard_count * 100) if hard_count > 0 else None

    recovery_score = 0
    blunder_count = 0
    for i, m in enumerate(moves):
        if m.eval_loss >= 200:
            next_moves = moves[i+1:i+4]
            if len(next_moves) == 3:
                blunder_count += 1
                recovery_acpl = sum(nx.eval_loss for nx in next_moves) / 3
                if recovery_acpl <= 10:
                    recovery_score += 1
    recovery_rate = (recovery_score / blunder_count * 100) if blunder_count > 0 else None

    # Top-5 및 순위 분포 분석 지표 산출
    u_len = len(unforced) if unforced else 1
    r_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
    for m in unforced:
        r_counts[m.engine_rank] += 1
        
    top5_unforced = [m for m in unforced if m.is_top_5]
    avg_rank_in_top5 = (sum(m.engine_rank for m in top5_unforced) / len(top5_unforced)) if top5_unforced else 0.0
    mean_proximity = (sum(m.cp_proximity for m in unforced) / u_len) if unforced else 0.0

    rank_profile = {
        "r1_rate": (r_counts[1] / u_len) * 100,
        "r2_rate": (r_counts[2] / u_len) * 100,
        "r3_rate": (r_counts[3] / u_len) * 100,
        "r4_5_rate": ((r_counts[4] + r_counts[5]) / u_len) * 100,
        "r6_plus_rate": (r_counts[6] / u_len) * 100,
        "avg_rank_top5": avg_rank_in_top5,
        "mean_proximity": mean_proximity,
        "top5_unforced_rate": (len(top5_unforced) / u_len) * 100
    }

    return min_window_acpl, hard_top1, recovery_rate, hard_count, rank_profile

def _rank_weighted_match(move: HistoryEntry) -> float:
    """순위 볼록 감쇄 매칭 (Rank 1: 1.0, Rank 2: 0.40, Rank 3: 0.18, Rank 4: 0.08, Rank 5: 0.03)"""
    if move.engine_rank == 1: return 1.00
    elif move.engine_rank == 2: return 0.40
    elif move.engine_rank == 3: return 0.18
    elif move.engine_rank == 4: return 0.08
    elif move.engine_rank == 5: return 0.03
    return 0.00

def calculate_tactical_burst(moves: List[HistoryEntry]) -> Tuple[float, List[TacticalBurstResult], str]:
    if len(moves) < 6: return 0.0, [], "단기 전술 버스트 특이점 없음"

    def clamp_map(val, in_min, in_max, out_min, out_max):
        if in_min < in_max:
            if val <= in_min: return out_min
            if val >= in_max: return out_max
            return out_min + (val - in_min) * (out_max - out_min) / (in_max - in_min)
        else:
            if val >= in_min: return out_min
            if val <= in_max: return out_max
            return out_min + (in_min - val) * (out_max - out_min) / (in_min - in_max)

    by_game: Dict[int, List[HistoryEntry]] = {}
    for m in sorted(moves, key=lambda x: (x.game_id, x.ply)):
        by_game.setdefault(m.game_id, []).append(m)

    scored: List[TacticalBurstResult] = []

    for game_id, game_moves in by_game.items():
        unforced = [m for m in game_moves if not m.is_forced]
        if len(unforced) < 6: continue

        baseline_losses = [m.eval_loss for m in unforced]
        baseline_acpl_all = sum(baseline_losses) / len(baseline_losses)
        baseline_rank_all = sum(_rank_weighted_match(m) for m in unforced) / len(unforced)
        baseline_std_all = math.sqrt(sum((x - baseline_acpl_all) ** 2 for x in baseline_losses) / len(baseline_losses))

        def local_profile(local_moves: List[HistoryEntry]) -> Tuple[float, float, float, float, float, float]:
            if not local_moves:
                err_rate = sum(1 for x in baseline_losses if x >= 50) / len(baseline_losses)
                severe_rate = sum(1 for x in baseline_losses if x >= 100) / len(baseline_losses)
                preserve_rate = sum(1 for x in baseline_losses if x <= 35) / len(baseline_losses)
                return baseline_acpl_all, baseline_rank_all, baseline_std_all, err_rate, severe_rate, preserve_rate
            local_losses = [x.eval_loss for x in local_moves]
            local_acpl = sum(local_losses) / len(local_losses)
            local_rank = sum(_rank_weighted_match(x) for x in local_moves) / len(local_moves)
            local_std = math.sqrt(sum((x - local_acpl) ** 2 for x in local_losses) / len(local_losses))
            err_rate = sum(1 for x in local_losses if x >= 50) / len(local_losses)
            severe_rate = sum(1 for x in local_losses if x >= 100) / len(local_losses)
            preserve_rate = sum(1 for x in local_losses if x <= 35) / len(local_losses)
            return local_acpl, local_rank, local_std, err_rate, severe_rate, preserve_rate

        difficult = []
        for m in game_moves:
            if m.is_forced or m.ply < 12 or abs(m.current_eval) >= 1800: continue
            is_hard = m.eval_gap <= 60
            is_tactical_close = m.is_critical and m.eval_gap <= 90
            has_candidate_choice = len(m.top_3_moves) >= 2
            if not has_candidate_choice or not (is_hard or is_tactical_close): continue
            difficult.append(m)

        for size in range(3, 7):
            if len(difficult) < size: continue
            for start in range(len(difficult) - size + 1):
                window = difficult[start:start + size]
                if window[-1].ply - window[0].ply > 18: continue

                losses = [m.eval_loss for m in window]
                w_acpl = sum(losses) / size
                w_rank = sum(_rank_weighted_match(m) for m in window) / size
                w_top1 = sum(1 for m in window if m.is_top_1) / size * 100
                w_std = math.sqrt(sum((x - w_acpl) ** 2 for x in losses) / size)
                w_err_rate = sum(1 for x in losses if x >= 50) / size
                w_severe_rate = sum(1 for x in losses if x >= 100) / size
                w_preserve_rate = sum(1 for x in losses if x <= 35) / size
                low_loss_count = sum(1 for x in losses if x <= 35)
                hard_count = sum(1 for m in window if m.eval_gap <= 50 or (m.is_critical and m.eval_gap <= 90))
                required_hard = size if size <= 4 else size - 1
                if hard_count < required_hard: continue

                outside = [m for m in unforced if not (window[0].ply <= m.ply <= window[-1].ply)]
                if len(outside) >= 4:
                    out_losses = [m.eval_loss for m in outside]
                    baseline_acpl = sum(out_losses) / len(out_losses)
                    baseline_rank = sum(_rank_weighted_match(m) for m in outside) / len(out_losses)
                    baseline_std = math.sqrt(sum((x - baseline_acpl) ** 2 for x in out_losses) / len(out_losses))
                    baseline_err_rate = sum(1 for x in out_losses if x >= 50) / len(out_losses)
                    baseline_severe_rate = sum(1 for x in out_losses if x >= 100) / len(out_losses)
                    baseline_preserve_rate = sum(1 for x in out_losses if x <= 35) / len(out_losses)
                else:
                    baseline_acpl, baseline_rank, baseline_std = baseline_acpl_all, baseline_rank_all, baseline_std_all
                    _, _, _, baseline_err_rate, baseline_severe_rate, baseline_preserve_rate = local_profile([])

                prev_context = [m for m in unforced if m.ply < window[0].ply][-6:]
                next_context = [m for m in unforced if m.ply > window[-1].ply][:6]
                prev_acpl, prev_rank, prev_std, prev_err_rate, prev_severe_rate, prev_preserve_rate = local_profile(prev_context)
                next_acpl, next_rank, next_std, next_err_rate, next_severe_rate, next_preserve_rate = local_profile(next_context)

                swing_count = 0
                recovery_count = 0
                for m in window:
                    prev_candidates = [pm for pm in game_moves if pm.ply < m.ply]
                    prev = prev_candidates[-1] if prev_candidates else None
                    if prev:
                        if abs(m.current_eval - prev.current_eval) >= 300: swing_count += 1
                        if prev.eval_loss >= 200: recovery_count += 1

                similar_count = 0
                for j in range(len(difficult) - size + 1):
                    other = difficult[j:j + size]
                    if other[-1].ply - other[0].ply > 18: continue
                    other_acpl = sum(x.eval_loss for x in other) / size
                    other_rank = sum(_rank_weighted_match(x) for x in other) / size
                    if other_acpl <= 8.0 and other_rank >= 0.70: similar_count += 1

                relative_gain = baseline_acpl - w_acpl
                rank_gain = w_rank - baseline_rank
                variance_gain = baseline_std - w_std
                prev_gain = prev_acpl - w_acpl
                next_gain = next_acpl - w_acpl
                prev_rank_gain = w_rank - prev_rank
                next_rank_gain = w_rank - next_rank
                transition_gain = max(prev_gain, (prev_gain + max(0.0, next_gain)) / 2.0)
                transition_rank_gain = max(prev_rank_gain, (prev_rank_gain + max(0.0, next_rank_gain)) / 2.0)
                transition_std_gain = max(prev_std - w_std, (prev_std + next_std) / 2.0 - w_std)
                pressure_err_rate = max(prev_err_rate, (prev_err_rate + next_err_rate) / 2.0, baseline_err_rate)
                pressure_severe_rate = max(prev_severe_rate, (prev_severe_rate + next_severe_rate) / 2.0, baseline_severe_rate)
                preservation_jump = w_preserve_rate - max(prev_preserve_rate, baseline_preserve_rate)
                error_suppression = max(0.0, pressure_err_rate - w_err_rate)
                severe_suppression = max(0.0, pressure_severe_rate - w_severe_rate)
                safe_continuations = sum(1 for m in window if m.uci != m.best_move and (m.eval_loss <= 35 or _rank_weighted_match(m) >= 0.40) and m.eval_loss <= 90)
                has_context = bool(swing_count or recovery_count)
                collapse_pressure = min(1.0,
                    (pressure_err_rate * 0.35) +
                    (pressure_severe_rate * 0.30) +
                    ((hard_count / size) * 0.20) +
                    (min(1.0, max(prev_std, baseline_std) / 60.0) * 0.10) +
                    (0.05 if has_context else 0.0)
                )
                stability_mode = (low_loss_count >= max(2, size - 1) and error_suppression >= 0.25 and transition_gain >= 14.0)
                safe_mode = (safe_continuations >= max(2, size - 2) and transition_gain >= 16.0) or (safe_continuations >= max(2, size - 2) and error_suppression >= 0.30)
                is_precision_island = (
                    (prev_gain >= 18.0 and next_gain >= 12.0 and transition_rank_gain >= 0.20)
                    or (prev_gain >= 28.0 and has_context and transition_rank_gain >= 0.14)
                    or (safe_mode and prev_gain >= 16.0 and rank_gain >= 0.20)
                    or (stability_mode and next_gain >= 8.0 and transition_rank_gain >= 0.22)
                )

                acpl_component = clamp_map(w_acpl, 35.0, 4.0, 0.0, 8.0)
                improvement_component = clamp_map(relative_gain, 18.0, 60.0, 0.0, 20.0)
                transition_component = clamp_map(transition_gain, 14.0, 55.0, 0.0, 24.0)
                error_component = clamp_map(error_suppression, 0.22, 0.70, 0.0, 22.0)
                severe_component = clamp_map(severe_suppression, 0.12, 0.45, 0.0, 12.0)
                preservation_component = clamp_map(preservation_jump, 0.20, 0.65, 0.0, 10.0)
                rank_component = clamp_map(rank_gain, 0.18, 0.50, 0.0, 7.0)
                transition_rank_component = clamp_map(transition_rank_gain, 0.14, 0.45, 0.0, 9.0)
                consistency_component = clamp_map(max(variance_gain, transition_std_gain), 10.0, 45.0, 0.0, 12.0)
                safe_component = clamp_map(safe_continuations, 1, 4, 0.0, 16.0) if (transition_gain >= 14.0 or error_suppression >= 0.25) else 0.0
                context_component = min(12.0, swing_count * 5.0 + recovery_count * 6.0)
                rarity_component = 8.0 if similar_count == 1 and (relative_gain >= 22.0 or error_suppression >= 0.30) else (4.0 if similar_count == 2 and transition_gain >= 24.0 else 0.0)
                island_component = (12.0 if is_precision_island and size >= 5 else (7.0 if is_precision_island else 0.0))

                globally_consistent_strong = baseline_acpl <= 18.0 and 12.0 <= baseline_std <= 45.0 and baseline_rank >= 0.55
                switch_in = (prev_gain >= 30.0 and (prev_err_rate - w_err_rate >= 0.30 or prev_std - w_std >= 12.0))
                switch_out = (len(next_context) >= 3 and next_gain >= 15.0 and (next_err_rate - w_err_rate >= 0.20 or next_std - w_std >= 8.0))
                collapse_resistance = (collapse_pressure >= 0.62 and error_suppression >= 0.35 and w_severe_rate == 0.0 and low_loss_count >= max(2, size - 1))
                deep_resource_signal = (transition_rank_gain >= 0.30 or (safe_continuations >= 2 and rank_gain >= 0.22 and w_rank >= 0.45) or (has_context and transition_rank_gain >= 0.20 and safe_continuations >= 1))
                human_explainable = (size <= 4 or similar_count >= 2 or (globally_consistent_strong and not (switch_in and switch_out)) or (baseline_acpl <= 24.0 and baseline_rank >= 0.60 and not switch_out))
                structural_abnormality = (size >= 5 and not human_explainable and switch_in and switch_out and transition_gain >= 35.0 and collapse_resistance and (w_std <= 6.0 or hard_count == size) and deep_resource_signal)

                stabilization_context = ((error_component + severe_component + preservation_component + safe_component + acpl_component + improvement_component + consistency_component) * 0.10)
                collapse_component = clamp_map(collapse_pressure, 0.62, 0.95, 0.0, 14.0) if structural_abnormality else 0.0
                structure_core = transition_component + transition_rank_component + rarity_component + island_component + context_component + collapse_component
                raw_score = (structure_core + stabilization_context) if structural_abnormality else min(18.0, structure_core * 0.15)

                length_weight = {3: 0.22, 4: 0.40, 5: 0.86, 6: 1.00}[size]
                raw_score *= length_weight

                if globally_consistent_strong and not structural_abnormality: raw_score *= (0.20 if size <= 4 else 0.35)
                elif globally_consistent_strong: raw_score *= (0.60 if size <= 4 else 0.75)
                elif baseline_acpl <= 24.0 and baseline_rank >= 0.60 and not structural_abnormality: raw_score *= (0.45 if size <= 4 else 0.65)
                if baseline_rank >= 0.72 and not structural_abnormality: raw_score *= 0.60
                if similar_count >= 2 and not structural_abnormality: raw_score *= 0.55
                if relative_gain < 15.0 and transition_gain < 18.0 and error_suppression < 0.25: raw_score *= 0.40
                if rank_gain < 0.12 and transition_rank_gain < 0.14 and error_suppression < 0.30 and not has_context: raw_score *= 0.55
                if not safe_mode and not stability_mode and (w_acpl > 35.0 or (w_rank < 0.40 and w_preserve_rate < 0.70)): raw_score *= 0.50
                elif safe_mode and w_rank < 0.25 and w_preserve_rate < 0.70: raw_score *= 0.70
                if w_std > 12.0 and error_suppression < 0.30: raw_score *= 0.70

                cap = {3: 18.0, 4: 28.0, 5: 58.0, 6: 68.0}[size]
                if structural_abnormality:
                    cap = {3: 24.0, 4: 38.0, 5: 76.0, 6: 84.0}[size]
                    if has_context and transition_gain >= 35.0: cap += {3: 0.0, 4: 4.0, 5: 6.0, 6: 4.0}[size]
                if not structural_abnormality and (safe_mode or stability_mode): cap = min(cap, 30.0 if size <= 4 else 42.0)
                if transition_gain < 25.0 and error_suppression < 0.45: cap = min(cap, 24.0 if size <= 4 else 38.0)
                if transition_rank_gain < 0.20 and not (error_suppression >= 0.45 and size >= 5): cap = min(cap, 24.0 if size <= 4 else 42.0)

                score = min(cap, max(0.0, raw_score))
                if score < 35.0: continue

                transition_score = min(100.0, max(0.0, transition_component + error_component + severe_component + preservation_component + consistency_component + island_component))
                reasons = []
                if structural_abnormality: reasons.append(f"고붕괴압 전환 구조({collapse_pressure*100:.0f}%)")
                if structural_abnormality and switch_in and switch_out: reasons.append("switch-in/out 확인")
                if w_acpl <= 35.0 and error_suppression >= 0.25: reasons.append(f"손실 억제(ACPL {w_acpl:.1f})")
                elif w_acpl <= 4.0: reasons.append(f"단기 ACPL {w_acpl:.1f}")
                if error_suppression >= 0.25: reasons.append(f"실수율 {error_suppression*100:.0f}%p 감소")
                if transition_gain >= 16.0: reasons.append(f"직전 대비 {transition_gain:.1f} 개선")
                if is_precision_island: reasons.append("일시적 안정화 섬")
                if safe_continuations >= 2: reasons.append(f"안전후보 {safe_continuations}회")
                if not reasons: reasons.append("검토용 국지 안정화")

                scored.append(TacticalBurstResult(
                    score=score, start_ply=window[0].ply + 1, end_ply=window[-1].ply + 1,
                    game_id=game_id, move_count=size, acpl=w_acpl, rank_match=w_rank * 100,
                    top1_rate=w_top1, std_dev=w_std, baseline_acpl=baseline_acpl,
                    baseline_rank=baseline_rank * 100, hard_count=hard_count,
                    swing_count=swing_count, recovery_count=recovery_count,
                    transition_score=transition_score, safe_continuations=safe_continuations,
                    island_count=1 if structural_abnormality else 0, commentary=", ".join(reasons)
                ))

    scored.sort(key=lambda b: b.score, reverse=True)
    filtered: List[TacticalBurstResult] = []
    for burst in scored:
        overlaps = any(burst.game_id == kept.game_id and not (burst.end_ply < kept.start_ply or burst.start_ply > kept.end_ply) for kept in filtered)
        if not overlaps: filtered.append(burst)
        if len(filtered) >= 3: break

    if not filtered: return 0.0, [], "단기 전술 버스트 특이점 없음"
    best = filtered[0]
    verdict = "다른 지표와 함께 검토할 국지 정밀도 상승" if best.score >= 70.0 else ("참고용 국지 정밀도 신호" if best.score >= 50.0 else "약한 단기 정밀도 신호(참고용)")
    return best.score, filtered, verdict

# ==============================================================================
# 기존 정밀도 윈도우 스캔 탐색 엔진 (다중 스케일 상관 분석과 병행)
# ==============================================================================
@dataclass
class SuspiciousSegment:
    start_ply: int
    end_ply: int
    game_id: int
    window_size: int
    acpl: float
    top1_rate: float
    weighted_top1: float
    suspicion_score: float
    verdict: str

@dataclass
class LocalCorrelationResult:
    """Interpretable, false-positive-aware summary of one multi-scale window."""
    start_ply: int
    end_ply: int
    game_id: int
    window_size: int
    phase: str
    score: float
    confidence: float
    acpl: float
    baseline_acpl: float
    top1_rate: float
    top3_rate: float
    top5_rate: float
    critical_agreement: float
    preference_weighted_agreement: float
    longest_exact_streak: int
    longest_engine_like_streak: int
    cluster_score: float
    baseline_lift: float
    contributions: Dict[str, float]

def _longest_streak(values: Sequence[bool], allowed_misses: int = 0) -> int:
    """Longest run, optionally allowing isolated misses (useful for every-few-moves use)."""
    left = misses = best = 0
    for right, value in enumerate(values):
        if not value: misses += 1
        while misses > allowed_misses:
            if not values[left]: misses -= 1
            left += 1
        best = max(best, right - left + 1)
    return best

def analyze_local_engine_correlation(moves: List[HistoryEntry]) -> Optional[LocalCorrelationResult]:
    """Find the strongest corroborated local engine-correlation window.

    Unlike the legacy maximum-ACPL scan, this measures exact and candidate-set
    imitation, intermittent clusters, difficult-position accuracy, and the
    change from the player's own same-game baseline.  Reliability and a modest
    scan penalty prevent a lucky five-move sequence from dominating the report.
    """
    def scale(value: float, low: float, high: float) -> float:
        if high == low: return 0.0
        return max(0.0, min(100.0, (value - low) * 100.0 / (high - low)))

    by_game: Dict[int, List[HistoryEntry]] = {}
    for move in sorted(moves, key=lambda x: (x.game_id, x.ply)):
        if not move.is_forced:
            by_game.setdefault(move.game_id, []).append(move)

    candidates: List[LocalCorrelationResult] = []
    tested_windows = sum(
        max(0, len(game_moves) - size + 1)
        for game_moves in by_game.values() for size in (5, 10, 15, 20, 30, 40)
    )
    for game_id, game_moves in by_game.items():
        for size in (5, 10, 15, 20, 30, 40):
            if len(game_moves) < size: continue
            for start in range(len(game_moves) - size + 1):
                window = game_moves[start:start + size]
                # Do not silently bridge a large unanalyzed/forced section.
                if window[-1].ply - window[0].ply > size * 3: continue
                outside = game_moves[:start] + game_moves[start + size:]
                losses = [m.eval_loss for m in window]
                acpl = sum(losses) / size
                baseline_acpl = (sum(m.eval_loss for m in outside) / len(outside)) if len(outside) >= 5 else acpl
                baseline_lift = max(0.0, baseline_acpl - acpl)

                top1 = sum(m.is_top_1 for m in window) / size * 100.0
                top3 = sum(m.is_top_3 for m in window) / size * 100.0
                top5 = sum(m.is_top_5 for m in window) / size * 100.0
                critical = [m for m in window if m.is_critical or m.eval_gap <= 60]
                critical_good = sum(m.is_top_3 and m.eval_loss <= 35 for m in critical)
                critical_rate = critical_good / len(critical) * 100.0 if critical else 0.0

                # A moderately large gap is informative, but forced moves have
                # already been removed and the weight is capped to avoid tactics.
                pref_weights = [1.0 + min(max(m.eval_gap, 0), 180) / 180.0 for m in window]
                pref_hits = [1.0 if m.is_top_1 else (0.68 if m.engine_rank == 2 else
                             (0.42 if m.engine_rank == 3 else (0.18 if m.is_top_5 else 0.0))) for m in window]
                pref_agreement = sum(w * h for w, h in zip(pref_weights, pref_hits)) / sum(pref_weights) * 100.0

                exact_flags = [m.is_top_1 for m in window]
                engine_like = [m.is_top_3 or m.eval_loss <= 20 for m in window]
                exact_streak = _longest_streak(exact_flags)
                tolerant_streak = _longest_streak(engine_like, allowed_misses=1)
                cluster = max(
                    scale(tolerant_streak / size, 0.35, 0.85),
                    scale(sum(engine_like) / size, 0.60, 0.92),
                )

                contributions = {
                    "exact_top1": scale(top1, 55.0, 88.0) * 0.20,
                    "candidate_set": scale(top3, 78.0, 98.0) * 0.18,
                    "low_loss": scale(acpl, 28.0, 5.0) * 0.17,
                    "preference_weighted": scale(pref_agreement, 48.0, 82.0) * 0.14,
                    "critical_positions": scale(critical_rate, 55.0, 92.0) * 0.11 if len(critical) >= 3 else 0.0,
                    "baseline_change": scale(baseline_lift, 10.0, 45.0) * 0.12 if len(outside) >= 5 else 0.0,
                    "cluster": cluster * 0.08,
                }
                raw = sum(contributions.values())
                corroboration = sum(value >= 6.0 for value in contributions.values())
                if corroboration < 3: raw = min(raw, 58.0)

                # Shrink short samples and maxima selected from many overlapping windows.
                reliability = min(1.0, math.sqrt(size / 15.0))
                scan_factor = 1.0 / (1.0 + 0.015 * math.log1p(tested_windows))
                score = 25.0 + (raw - 25.0) * reliability * scan_factor
                opening_fraction = sum(m.ply < 20 for m in window) / size
                score *= 1.0 - 0.25 * opening_fraction
                if baseline_acpl <= 18.0 and baseline_lift < 10.0:
                    score *= 0.78  # sustained elite play is not a switch-in signal
                score = max(0.0, min(99.0, score))
                confidence = min(100.0, reliability * 70.0 + min(30.0, corroboration * 5.0))
                mid_ply = (window[0].ply + window[-1].ply) / 2.0
                phase = "opening" if mid_ply < 30 else ("middlegame" if mid_ply < 70 else "endgame")
                candidates.append(LocalCorrelationResult(
                    window[0].ply + 1, window[-1].ply + 1, game_id, size, phase,
                    score, confidence, acpl, baseline_acpl, top1, top3, top5,
                    critical_rate, pref_agreement, exact_streak, tolerant_streak,
                    cluster, baseline_lift, contributions
                ))
    return max(candidates, key=lambda result: result.score) if candidates else None

def scan_suspicious_segments(moves: List[HistoryEntry], max_segments: int = 5) -> List[SuspiciousSegment]:
    # Aggregated target reports contain several games.  Never manufacture a
    # window by joining the end of one game to the beginning of the next.
    game_ids = {m.game_id for m in moves}
    if len(game_ids) > 1:
        per_game: List[SuspiciousSegment] = []
        for game_id in game_ids:
            per_game.extend(scan_suspicious_segments(
                [m for m in moves if m.game_id == game_id], max_segments=max_segments
            ))
        per_game.sort(key=lambda segment: segment.suspicion_score, reverse=True)
        return per_game[:max_segments]
    unforced_moves = [m for m in moves if not m.is_forced]
    if len(unforced_moves) < 4: return []

    def clamp_map(val, in_min, in_max, out_min, out_max):
        if in_min < in_max:
            if val <= in_min: return out_min
            if val >= in_max: return out_max
            return out_min + (val - in_min) * (out_max - out_min) / (in_max - in_min)
        else:
            if val >= in_min: return out_min
            if val <= in_max: return out_max
            return out_min + (in_min - val) * (out_max - out_min) / (in_min - in_max)

    global_stats = calc_stats(moves)
    global_std = global_stats[8]
    global_blunder = global_stats[7]
    global_mistake = global_stats[6]
    global_inacc = global_stats[5]

    human_dampener = 1.0
    if global_std > 20.0: human_dampener *= max(0.6, 1.0 - (global_std - 20.0) / 50.0)
    if global_blunder >= 1: human_dampener *= 0.75
    elif global_mistake >= 2: human_dampener *= 0.85

    inconsistency_credit = 1.0
    if global_blunder >= 1 or global_mistake >= 3 or global_inacc >= 6: inconsistency_credit = 0.80
    elif global_mistake >= 1 or global_inacc >= 3: inconsistency_credit = 0.90
    elif global_std > 22.0: inconsistency_credit = 0.95

    WINDOWS = [4, 6, 8, 12, 16, 20]
    all_candidates: List[SuspiciousSegment] = []

    for w_size in WINDOWS:
        if len(unforced_moves) < w_size: continue
        for i in range(len(unforced_moves) - w_size + 1):
            window = unforced_moves[i : i + w_size]
            w_acpl = sum(m.eval_loss for m in window) / w_size
            weighted_matches = 0.0
            total_weight = 0.0
            top1_matches = 0
            blunders = 0
            mistakes = 0
            early_moves_count = 0
            losses = []
            
            for m in window:
                losses.append(m.eval_loss)
                weight = get_difficulty_weight(m.eval_gap)
                total_weight += weight
                if m.is_top_1:
                    weighted_matches += weight
                    top1_matches += 1
                if m.eval_loss >= 200: blunders += 1
                elif m.eval_loss >= 100: mistakes += 1
                if m.ply < 20: early_moves_count += 1
            
            top1_rate = (top1_matches / w_size) * 100
            weighted_top1 = (weighted_matches / total_weight) * 100 if total_weight > 0 else 0.0

            w_mean = sum(losses) / w_size
            w_variance = sum((x - w_mean) ** 2 for x in losses) / w_size
            w_std = math.sqrt(w_variance)
            segment_variance_credit = 1.0
            if w_std > 0.0: segment_variance_credit = clamp_map(w_std, 1.0, 12.0, 1.0, 0.80)
            
            size_factor = {4: 0.20, 6: 0.35, 8: 0.50, 12: 0.70, 16: 0.90, 20: 1.00}.get(w_size, 1.0)
            
            if weighted_top1 <= 60.0: effective_top1 = clamp_map(weighted_top1, 0.0, 60.0, 0.0, 25.0)
            else: effective_top1 = clamp_map(weighted_top1, 60.0, 100.0, 25.0, 100.0)

            base_score = (effective_top1 * 0.6) + (max(0.0, 100.0 - w_acpl) * 0.4)

            prev_unforced = unforced_moves[max(0, i-6):i]
            next_unforced = unforced_moves[i+w_size:i+w_size+6]
            context_moves = prev_unforced + next_unforced
            if context_moves:
                context_acpl = sum(m.eval_loss for m in context_moves) / len(context_moves)
                persistence_factor = clamp_map(context_acpl, 20.0, 45.0, 1.0, 0.7) if context_acpl > 20.0 else 1.05
            else: persistence_factor = 1.0

            if 3.0 <= w_acpl <= 12.0: acpl_floor_factor = clamp_map(w_acpl, 3.0, 12.0, 0.85, 0.75)
            elif 12.0 < w_acpl <= 25.0: acpl_floor_factor = clamp_map(w_acpl, 12.0, 25.0, 0.75, 0.60)
            elif w_acpl > 25.0: acpl_floor_factor = 0.50
            else: acpl_floor_factor = 1.0

            suspicion_score = base_score * size_factor * human_dampener * persistence_factor * acpl_floor_factor * inconsistency_credit * segment_variance_credit
            if early_moves_count > 0: suspicion_score *= (1.0 - 0.40 * (early_moves_count / w_size))
            
            penalty = (blunders * 25.0) + (mistakes * 10.0)
            suspicion_score = max(0.0, suspicion_score - penalty)
            
            if suspicion_score >= 90.0: verdict = "🔴 일치도가 극도로 높은 이례적인 통계적 특이성"
            elif suspicion_score >= 70.0: verdict = "🟡 정밀 검토가 요구되는 높은 정교함 및 기계적 연관성"
            elif suspicion_score >= 40.0: verdict = "🟠 최상위권 프로 및 고수 수준의 전술적 일치"
            else: verdict = "🟢 자연스러운 인간 대국자의 흐름 및 정밀도"

            all_candidates.append(SuspiciousSegment(
                start_ply=window[0].ply + 1, end_ply=window[-1].ply + 1,
                game_id=window[0].game_id, window_size=w_size, acpl=w_acpl,
                top1_rate=top1_rate, weighted_top1=weighted_top1,
                suspicion_score=suspicion_score, verdict=verdict
            ))

    all_candidates.sort(key=lambda x: x.suspicion_score, reverse=True)
    high_score_disjoint_count = 0
    temp_selected = []
    for cand in all_candidates:
        overlap = any(cand.game_id == sel.game_id and not (cand.end_ply < sel.start_ply or cand.start_ply > sel.end_ply) for sel in temp_selected)
        if not overlap:
            temp_selected.append(cand)
            if cand.suspicion_score >= 45.0: high_score_disjoint_count += 1

    for cand in all_candidates:
        if cand.suspicion_score >= 70.0 and high_score_disjoint_count <= 1:
            cand.suspicion_score *= 0.80
            if cand.suspicion_score < 70.0: cand.verdict = "🟠 최상위권 프로 및 고수 수준의 전술적 일치"

    selected_segments: List[SuspiciousSegment] = []
    for cand in all_candidates:
        if len(selected_segments) >= max_segments: break
        overlap = any(cand.game_id == sel.game_id and not (cand.end_ply < sel.start_ply or cand.start_ply > sel.end_ply) for sel in selected_segments)
        if not overlap: selected_segments.append(cand)

    return selected_segments

def calculate_partial_ai_probability(moves: List[HistoryEntry]) -> Tuple[float, str, List[int]]:
    segs = scan_suspicious_segments(moves, max_segments=1)
    local = analyze_local_engine_correlation(moves)
    legacy_score = segs[0].suspicion_score if segs else 0.0
    local_score = local.score if local else 0.0
    if not segs and not local:
        return 0.0, "🟢 특이 구간 없음 (자연스러운 수순)", [0, 0]

    # The two scanners are deliberately different. Agreement is stronger than
    # either maximum alone; disagreement receives only a small uplift.
    if legacy_score >= 45.0 and local_score >= 45.0:
        combined = max(legacy_score, local_score) + 0.20 * min(legacy_score, local_score)
    else:
        combined = max(legacy_score, local_score)
    combined = min(99.0, combined)
    if local and local_score >= legacy_score:
        bounds = [local.start_ply, local.end_ply]
    else:
        bounds = [segs[0].start_ply, segs[0].end_ply]
    if combined >= 90.0: verdict = "🔴 다중 지표가 일치하는 극단적 국지 엔진 상관"
    elif combined >= 65.0: verdict = "🟡 정밀 검토가 필요한 국지 엔진 상관"
    elif combined >= 40.0: verdict = "🟠 참고용 국지 정밀도 상승"
    else: verdict = "🟢 자연스러운 인간 대국자의 흐름 및 정밀도"
    return combined, verdict, bounds

def calculate_cheat_probability(moves: List[HistoryEntry]) -> Tuple[float, float, str]:
    if len(moves) < 5: return 0.0, 0.0, "⚪ 판독 불가 (수순 부족)"

    def clamp_map(val, in_min, in_max, out_min, out_max):
        if in_min < in_max:
            if val <= in_min: return out_min
            if val >= in_max: return out_max
            return out_min + (val - in_min) * (out_max - out_min) / (in_max - in_min)
        else:
            if val >= in_min: return out_min
            if val <= in_max: return out_max
            return out_min + (in_min - val) * (out_max - out_min) / (in_min - in_max)

    avoided_moves = []
    normal_moves = []
    avoidance_weight_total = 0.0
    real_mistakes = 0
    real_blunders = 0

    for m in moves:
        best_eval = cap_score(m.current_eval + m.eval_loss)
        is_intentional_avoidance = (
            best_eval >= 400 and
            m.eval_loss >= 100 and
            m.current_eval >= 150 and
            m.is_top_3 and not m.is_top_1
        )
        if is_intentional_avoidance:
            avoided_moves.append(m)
            weight = 1.0
            if m.eval_loss >= 300: weight += 1.0 
            if best_eval >= 800: weight += 1.0   
            avoidance_weight_total += weight
        else:
            normal_moves.append(m)
            if m.eval_loss >= 200: real_blunders += 1
            elif m.eval_loss >= 100: real_mistakes += 1

    if not normal_moves: normal_moves = moves
    
    adj_losses = [m.eval_loss for m in normal_moves]
    adj_acpl = sum(adj_losses) / len(adj_losses) if adj_losses else 0.0
    adj_unforced = [m for m in normal_moves if not m.is_forced]
    adj_u_top1 = (sum(1 for m in adj_unforced if m.is_top_1) / len(adj_unforced) * 100) if adj_unforced else 0.0
    adj_top3 = (sum(1 for m in normal_moves if m.is_top_3) / len(normal_moves) * 100) if normal_moves else 0.0

    em_moves = [m for m in normal_moves if m.ply <= 69]
    if not em_moves: em_moves = normal_moves
    em_acpl = sum(m.eval_loss for m in em_moves) / len(em_moves) if em_moves else adj_acpl

    # 1. 2D 경험적 LLR 순차 우도비(SPRT) 궤적 누적
    unforced_all = [m for m in moves if not m.is_forced]
    if unforced_all:
        total_llr = sum(get_empirical_binned_llr(m.eval_gap, m.eval_loss) for m in unforced_all)
        # Normalize evidence growth: raw summation otherwise saturates merely
        # because a game is long.  sqrt(n) still rewards persistent evidence.
        llr_scale = max(6.0, math.sqrt(len(unforced_all)) * 1.5)
        sprt_score = 1.0 / (1.0 + math.exp(-total_llr / llr_scale)) * 100.0
    else:
        sprt_score = 0.0

    # 2. 기본 점수 계산 (경험적 LLR 50% 앙상블)
    acpl_score = clamp_map(em_acpl, 9.0, 3.0, 0.0, 100.0)
    match_score = max(clamp_map(adj_u_top1, 65.0, 85.0, 0.0, 100.0), clamp_map(adj_top3, 85.0, 95.0, 0.0, 100.0))
    base_prob = (acpl_score * 0.55) + (match_score * 0.45)
    base_prob = (base_prob * 0.5) + (sprt_score * 0.5)

    bot_armor = clamp_map(em_acpl, 10.0, 3.0, 0.0, 1.0)
    if real_blunders >= 1: bot_armor *= 0.2

    stats = calc_stats(moves)
    std_dev = stats[8]
    human_err = clamp_map(real_blunders + real_mistakes, 0, 3, 0.0, 100.0)
    human_var = clamp_map(std_dev, 15.0, 35.0, 0.0, 100.0) 
    
    # [Top-5 후보수 분산도에 따른 프로 기사 보호 지수 추가]
    _, _, _, _, rank_prof = calc_advanced_stats(moves)
    r2_r5_coverage = rank_prof["r2_rate"] + rank_prof["r3_rate"] + rank_prof["r4_5_rate"]
    dispersion_bonus = clamp_map(r2_r5_coverage, 15.0, 45.0, 0.0, 30.0) if rank_prof["r1_rate"] <= 75.0 else 0.0

    humanity_index = (human_err + human_var + dispersion_bonus) / (2.0 if dispersion_bonus == 0 else 2.5)
    full_prob = base_prob - (humanity_index * 0.5 * (1.0 - bot_armor))

    # 스마트 치팅 판독
    centaur_prob = 0.0
    centaur_flags = []
    variance_gate = clamp_map(std_dev, 45.0, 70.0, 0.1, 1.0)
    if avoidance_weight_total >= 7.5: variance_gate = max(0.8, variance_gate)

    if avoidance_weight_total >= 3.0:
        if adj_acpl <= 35.0:
            s_avoid = clamp_map(avoidance_weight_total, 3.0, 10.0, 15.0, 60.0)
            s_acpl = clamp_map(adj_acpl, 35.0, 10.0, 10.0, 40.0)
            score = (s_avoid + s_acpl) * variance_gate
            centaur_prob += score
            if score >= 20.0: centaur_flags.append(f"이득 회피/차선책(가중치 {avoidance_weight_total:.1f})")

    early_moves = [m for m in normal_moves if m.ply <= 29]
    mid_moves = [m for m in normal_moves if 30 <= m.ply <= 69]
    e_acpl = sum(m.eval_loss for m in early_moves)/len(early_moves) if early_moves else adj_acpl
    m_acpl = sum(m.eval_loss for m in mid_moves)/len(mid_moves) if mid_moves else adj_acpl
    
    phase_diff = e_acpl - m_acpl
    if phase_diff >= 35.0 and m_acpl <= 20.0: variance_gate = max(0.9, variance_gate) 
    if phase_diff >= 22.0 and m_acpl <= 20.0:
        added = clamp_map(phase_diff, 22.0, 55.0, 20.0, 75.0)
        score = added * variance_gate
        centaur_prob += score
        if score >= 20.0: centaur_flags.append(f"승부처 급격한 성능 향상(ACPL {m_acpl:.1f})")

    if adj_u_top1 >= 70.0 and adj_acpl <= 8.0:
        added = clamp_map(adj_u_top1, 70.0, 90.0, 15.0, 40.0)
        score = added * variance_gate
        centaur_prob += score
        if score >= 15.0 and not any("안전수" in f for f in centaur_flags):
            centaur_flags.append("비강제 Top-1 극단적 일치율")

    unforced_crit = [m for m in unforced_all if m.is_critical]
    unforced_noncrit = [m for m in unforced_all if not m.is_critical]
    if len(unforced_crit) >= 5 and len(unforced_noncrit) >= 10:
        mean_c = sum(m.eval_loss for m in unforced_crit) / len(unforced_crit)
        mean_nc = sum(m.eval_loss for m in unforced_noncrit) / len(unforced_noncrit)
        all_l = [m.eval_loss for m in unforced_all]
        std_all = math.sqrt(sum((x - (sum(all_l)/len(all_l)))**2 for x in all_l) / len(all_l)) + 1e-6
        cnai_val = (mean_nc - mean_c) / std_all
        if cnai_val >= 0.75 and adj_acpl <= 25.0:
            centaur_prob = max(centaur_prob, full_prob + 15.0)
            centaur_flags.append(f"승부처 편중 정밀도(CNAI {cnai_val:.2f})")

    final_full_prob = max(full_prob, centaur_prob)
    final_full_prob = min(99.0, max(0.0, final_full_prob))

    partial_prob, p_verdict, s_range = calculate_partial_ai_probability(moves)
    segment_partial_prob = partial_prob
    tactical_prob, tactical_bursts, tactical_verdict = calculate_tactical_burst(moves)
    global_support = max(final_full_prob, segment_partial_prob)
    if tactical_prob >= 70.0 and global_support >= 50.0:
        partial_prob = max(partial_prob, min(75.0, global_support + min(10.0, (tactical_prob - 70.0) / 2.0)))

    final_verdict = ""
    if centaur_prob >= 65.0 and centaur_prob >= full_prob:
        flag_str = ", ".join(centaur_flags[:2])
        if not flag_str: flag_str = "통계적 특이 지표 다수"
        spike_info = f" [의심 구간: {s_range[0]}~{s_range[1]}수]" if segment_partial_prob >= 65.0 else ""
        final_verdict = f"🟡 [특이 패턴 감지] 수순 전반에 걸쳐 부분적인 고가중 매칭 구간 관찰 ({flag_str}){spike_info}"
    elif partial_prob > final_full_prob + 10.0 and partial_prob >= 65.0:
        final_verdict = f"{p_verdict} [의심 구간: {s_range[0]}~{s_range[1]}수]"
    else:
        if final_full_prob >= 90.0: final_verdict = "🔴 일치도가 극도로 높은 이례적인 통계적 특이성"
        elif final_full_prob >= 70.0: final_verdict = "🟡 정밀 검토가 요구되는 높은 정교함 및 기계적 연관성"
        elif final_full_prob >= 40.0: final_verdict = "🟠 최상위권 프로 및 고수 수준의 정교한 대국 내용"
        else: final_verdict = "🟢 자연스러운 인간 대국자의 흐름 및 편차"

    return final_full_prob, partial_prob, final_verdict

def pad_korean(s: str, width: int, align: str = "center") -> str:
    visual_width = sum(2 if ord(c) > 0x7F else 1 for c in s)
    padding = max(0, width - visual_width)
    if align == "left": return s + (" " * padding)
    elif align == "right": return (" " * padding) + s
    left = padding // 2
    return (" " * left) + s + (" " * (padding - left))

def format_adv_metric(val: Optional[float], is_percent: bool = False) -> str:
    if val is None: return "-"
    return f"{val:.1f}%" if is_percent else f"{val:.1f}"

def format_tactical_burst_cell(score: float, bursts: List[TacticalBurstResult]) -> str:
    if not bursts: return f"{score:.1f}% / -"
    best = bursts[0]
    return f"{score:.1f}% / {best.start_ply}~{best.end_ply}수"

# ==============================================================================
# 터미널 시각화 및 리포트 출력부
# ==============================================================================
def generate_ascii_eval_curve(moves: List[HistoryEntry], width: int = 65, height: int = 10) -> str:
    if not moves: return " [!] 시각화할 대국 데이터가 존재하지 않습니다."
    evals = [cap_score(m.current_eval) for m in moves]
    min_val, max_val = min(evals), max(evals)
    val_range = max_val - min_val
    if val_range == 0: val_range = 1
    
    grid = [[" " for _ in range(width)] for _ in range(height)]
    num_moves = len(moves)
    
    for col in range(width):
        move_idx = int((col / (width - 1)) * (num_moves - 1)) if width > 1 else 0
        curr_val = evals[move_idx]
        row = int(((curr_val - min_val) / val_range) * (height - 1))
        row = max(0, min(height - 1, row))
        grid[height - 1 - row][col] = "●" if col in (0, width-1) or col % 5 == 0 else "·"

    lines = []
    for r in range(height):
        val_at_row = max_val - (r / (height - 1)) * val_range if height > 1 else max_val
        val_label = f"{val_at_row / 100.0:+5.1f} | "
        lines.append(val_label + "".join(grid[r]))
         
    lines.append("-" * (width + 8))
    x_label_chars = [" "] * width
    cols_to_label = [0, int(width * 0.25), int(width * 0.50), int(width * 0.75), width - 1]
    
    for col in cols_to_label:
        move_idx = int((col / (width - 1)) * (num_moves - 1)) if width > 1 else 0
        tgt_move = moves[move_idx]
        ply_num_str = str(tgt_move.ply + 1)
        str_len = len(ply_num_str)
        start_pos = 0 if col == 0 else (width - str_len if col == width - 1 else col - (str_len // 2))
        for idx_char, char in enumerate(ply_num_str):
            pos = start_pos + idx_char
            if 0 <= pos < width: x_label_chars[pos] = char
                
    lines.append("Ply:    " + "".join(x_label_chars))
    return "\n".join(lines)

def analyze_move_range(moves: List[HistoryEntry], start_ply: int, end_ply: int) -> List[HistoryEntry]:
    return [m for m in moves if start_ply <= (m.ply + 1) <= end_ply]

def print_suspicious_segments_report(moves: List[HistoryEntry], name: str):
    segs = scan_suspicious_segments(moves, max_segments=5)
    print(f"\n [ {name} - Top 5 비중복 국지적 의심 구간 상세 ]")
    header = f" {pad_korean('의심 순위', 10)} | {pad_korean('범위(수)', 12)} | {pad_korean('윈도우', 8)} | {pad_korean('의심도', 11)} | {pad_korean('구간 ACPL', 11)} | {pad_korean('가중 일치율', 13)} | 판독 소견"
    print(header)
    print("-" * 115)
    if not segs:
        print(f" {pad_korean('기록 없음', 115)}")
        return
    for idx, s in enumerate(segs, 1):
        row = f" {pad_korean(f'# {idx}', 10)} | {pad_korean(f'{s.start_ply}~{s.end_ply}', 12)} | {pad_korean(f'{s.window_size}수', 8)} | {pad_korean(f'{s.suspicion_score:.1f}%', 11)} | {s.acpl:11.2f} | {pad_korean(f'{s.weighted_top1:.1f}%', 13)} | {s.verdict}"
        print(row)
    print("-" * 115)

def print_local_correlation_report(rows: Dict[str, List[HistoryEntry]]) -> None:
    """Print the strongest multi-scale window and the reasons it scored highly."""
    print("\n [ 다중 스케일 국지 엔진 상관 진단 (5/10/15/20/30/40수) ]")
    header = f" {pad_korean('진영', 12)} | {pad_korean('최강 구간', 14)} | {pad_korean('크기/국면', 15)} | {pad_korean('점수/신뢰도', 16)} | {pad_korean('Top1/3/5', 22)} | {pad_korean('연속/군집', 14)}"
    print(header)
    print("-" * 115)
    for name, moves in rows.items():
        result = analyze_local_engine_correlation(moves)
        if not result:
            print(f" {pad_korean(name, 12)} | {pad_korean('표본 부족', 99)}")
            continue
        ranks = f"{result.top1_rate:.0f}/{result.top3_rate:.0f}/{result.top5_rate:.0f}%"
        streaks = f"{result.longest_exact_streak}/{result.longest_engine_like_streak} ({result.cluster_score:.0f})"
        print(f" {pad_korean(name, 12)} | {pad_korean(f'{result.start_ply}~{result.end_ply}', 14)} | "
              f"{pad_korean(f'{result.window_size}/{result.phase}', 15)} | "
              f"{pad_korean(f'{result.score:.1f}/{result.confidence:.0f}%', 16)} | "
              f"{pad_korean(ranks, 22)} | {pad_korean(streaks, 14)}")
        strongest = sorted(result.contributions.items(), key=lambda item: item[1], reverse=True)[:4]
        reasons = ", ".join(f"{key} +{value:.1f}" for key, value in strongest if value > 0.0) or "corroborating signal 없음"
        print(f" {'':12} | ↳ ACPL {result.acpl:.1f} (동일게임 기준 {result.baseline_acpl:.1f}, 향상 {result.baseline_lift:.1f}); "
              f"승부처 Top-3 {result.critical_agreement:.0f}%; 선호강도 가중 {result.preference_weighted_agreement:.0f}%; 기여: {reasons}")
    print("-" * 115)
def print_candidate_profile_report(moves_dict: Dict[str, List[HistoryEntry]]):
    """[진단 핵심] Top-1 -> Top-3 -> Top-5 선택 깔때기 및 순위 분산 진단표"""
    print("\n [ 후보수 순위 분포 및 CP 근접도 심층 진단 (Top-5 Selection Profile) ]")
    header = f" {pad_korean('진영', 10)} | {pad_korean('Top-1 깔때기 (1->3->5)', 25)} | {pad_korean('순위 분포 (R1 / R2 / R3 / R4-5 / R6+)', 38)} | {pad_korean('Top5평균순위', 12)} | {pad_korean('CP근접도', 10)}"
    print(header)
    print("-" * 115)
    for name, m_list in moves_dict.items():
        if not m_list: continue
        unforced = [m for m in m_list if not m.is_forced]
        u_len = len(unforced) if unforced else 1
        t1 = sum(1 for m in unforced if m.is_top_1) / u_len * 100
        t3 = sum(1 for m in unforced if m.is_top_3) / u_len * 100
        t5 = sum(1 for m in unforced if m.is_top_5) / u_len * 100
        funnel_str = f"{t1:.1f}% ➔ {t3:.1f}% ➔ {t5:.1f}%"
        
        _, _, _, _, prof = calc_advanced_stats(m_list)
        dist_str = f"{prof['r1_rate']:.0f}% / {prof['r2_rate']:.0f}% / {prof['r3_rate']:.0f}% / {prof['r4_5_rate']:.0f}% / {prof['r6_plus_rate']:.0f}%"
        prox_str = f"{prof['mean_proximity']:.1f}%"
        
        row = f" {pad_korean(name, 10)} | {pad_korean(funnel_str, 25)} | {pad_korean(dist_str, 38)} | {prof['avg_rank_top5']:12.2f} | {pad_korean(prox_str, 10)}"
        print(row)
    print("-" * 115)
    print(" ※ [해석 팁] 정상 프로 기사는 Top-5 커버율이 90%를 넘더라도 R2~R5의 완만한 분산(20~40%)과 Top-5 평균 순위 1.6~2.2를 유지합니다.")
    print("              AI는 R1 비율이 극단적으로 높고(80%↑), Top-5 평균 순위가 1.1~1.3에 수렴합니다.")

def print_tactical_burst_details(rows: List[Tuple[str, float, List[TacticalBurstResult], str]]) -> None:
    print("\n [ 붕괴압 전환 참고 지표 (5~6수 구조 이상 중심) ]")
    header = f" {pad_korean('진영', 12)} | {pad_korean('참고 점수/구간', 22)} | {pad_korean('검토 근거', 58)}"
    print(header)
    print("-" * 105)
    for name, score, bursts, verdict in rows:
        if bursts:
            best = bursts[0]
            detail = f"{verdict} ({best.move_count}수, ACPL {best.acpl:.1f}, 순위가중 {best.rank_match:.0f}%, 구조전환 {best.transition_score:.0f}, 안전후보 {best.safe_continuations})"
        else: detail = verdict
        print(f" {pad_korean(name, 12)} | {pad_korean(format_tactical_burst_cell(score, bursts), 22)} | {detail}")
        for extra in bursts[:2]:
            print(f" {'':12} | {'':22} | ↳ G{extra.game_id} {extra.start_ply}~{extra.end_ply}수: {extra.commentary}")

def print_target_report(target_moves: List[HistoryEntry], opp_moves: List[HistoryEntry], game_count: int, stage_name: str, use_db: bool = False, search_config: str = "") -> None:
    if not target_moves: return
    t_stats = calc_stats(target_moves)
    o_stats = calc_stats(opp_moves)
    t_adv = calc_advanced_stats(target_moves)
    o_adv = calc_advanced_stats(opp_moves)

    t_fprob, t_pprob, t_verdict = calculate_cheat_probability(target_moves)
    o_fprob, o_pprob, o_verdict = calculate_cheat_probability(opp_moves)
    t_burst_score, t_bursts, t_burst_verdict = calculate_tactical_burst(target_moves)
    o_burst_score, o_bursts, o_burst_verdict = calculate_tactical_burst(opp_moves)

    def format_phase(moves, start, end):
        val = get_numeric_phase_acpl(moves, start, end)
        return f"{val:.1f}" if val is not None else "-"

    print("\n" + "="*115)
    print(pad_korean(f"장기 기보 AI 유사도 프로파일링 리포트 [ 다중 기보 누적/타겟 분석 ] - {stage_name}", 115))
    print(pad_korean(f"총 분석 게임 수: {game_count} 게임 / 타겟 분석 수순: {len(target_moves)}수", 115))
    print("="*115)
    
    print("\n [ 타겟 진영 실시간 형세 추세 시각화 (Evaluation Curve) ]")
    print(generate_ascii_eval_curve(target_moves))
    print("-" * 115)

    print(f" [ 핵심 지표 (강제수 필터링 & MultiPV=5 순위 확장 적용) ]")
    header = f" {pad_korean('진영', 12)} | {pad_korean('전체ACPL', 11)} | {pad_korean('비강제ACPL', 12)} | {pad_korean('편차(기복)', 11)} | {pad_korean('전체Top-3', 11)} | {pad_korean('전체Top-5', 11)} | {pad_korean('비강제Top-1', 12)} | {pad_korean('난전Top-1', 11)}"
    print(header)
    print("-" * 115)
    for name, s in [("타겟(분석)", t_stats), ("상대방(평균)", o_stats)]:
        row = f" {pad_korean(name, 12)} | {s[0]:11.2f} | {s[11]:12.2f} | {s[8]:11.2f} | {pad_korean(f'{s[2]:.1f}%', 11)} | {pad_korean(f'{s[3]:.1f}%', 11)} | {pad_korean(f'{s[10]:.1f}%', 12)} | {pad_korean(f'{s[9]:.1f}%', 11)}"
        print(row)
    
    print("\n [ 세분화된 수순 평가 ]")
    header2 = f" {pad_korean('진영', 12)} | {pad_korean('완벽수(≤5cp)', 14)} | {pad_korean('의문수(50~99)', 14)} | {pad_korean('일반실수(100~199)', 14)} | {pad_korean('치명적실수(≥200)', 14)}"
    print(header2)
    print("-" * 115)
    for name, s in [("타겟(분석)", t_stats), ("상대방(평균)", o_stats)]:
        row = f" {pad_korean(name, 12)} | {pad_korean(f'{s[4]} 회', 14)} | {pad_korean(f'{s[5]} 회', 14)} | {pad_korean(f'{s[6]} 회', 14)} | {pad_korean(f'{s[7]} 회', 14)}"
        print(row)

    print("\n [ 구간별 점수 손실 (Phase Analysis) ] *(후반부 AI 평가치 변동 보정용)*")
    header3 = f" {pad_korean('진영', 12)} | {pad_korean('초반 (1~30수)', 28)} | {pad_korean('중반 (31~70수)', 28)} | {pad_korean('종반 (71수 이후)', 28)}"
    print(header3)
    print("-" * 115)
    for name, m in [("타겟(분석)", target_moves), ("상대방(평균)", opp_moves)]:
        row = f" {pad_korean(name, 12)} | {pad_korean(format_phase(m, 0, 29), 28)} | {pad_korean(format_phase(m, 30, 69), 28)} | {pad_korean(format_phase(m, 70, 999), 28)}"
        print(row)

    print("\n [ 특정 구간 AI 밀착도 심층 지표 ]")
    header4 = f" {pad_korean('진영', 12)} | {pad_korean('최고성능구간(10수) ACPL', 26)} | {pad_korean('어려운 포지션(격차<50) Top-1', 30)} | {pad_korean('치명적실수 직후(3수) 회복률', 30)}"
    print(header4)
    print("-" * 115)
    for name, a in [("타겟(분석)", t_adv), ("상대방(평균)", o_adv)]:
        row = f" {pad_korean(name, 12)} | {pad_korean(format_adv_metric(a[0]), 26)} | {pad_korean(format_adv_metric(a[1], True), 30)} | {pad_korean(format_adv_metric(a[2], True), 30)}"
        print(row)

    print_candidate_profile_report({"타겟(분석)": target_moves, "상대방(평균)": opp_moves})
    print_suspicious_segments_report(target_moves, "타겟(분석)")
    print_local_correlation_report({"타겟(분석)": target_moves, "상대방(평균)": opp_moves})

    print_tactical_burst_details([
        ("타겟(분석)", t_burst_score, t_bursts, t_burst_verdict),
        ("상대방(평균)", o_burst_score, o_bursts, o_burst_verdict),
    ])

    print("="*115)
    print(pad_korean("[ 종합 참고 소견 (Reference Verdict) ]", 115))
    print("-" * 115)
    print(f" {pad_korean('진영', 12)} | {pad_korean('전체 AI 유사도', 20)} | {pad_korean('구간 AI 유사도', 20)} | 통계적 분석 소견")
    print("-" * 115)
    print(f" {pad_korean('타겟(분석)', 12)} | {pad_korean(f'{t_fprob:.1f}%', 20)} | {pad_korean(f'{t_pprob:.1f}%', 20)} | {t_verdict}")
    print(f" {pad_korean('상대방(평균)', 12)} | {pad_korean(f'{o_fprob:.1f}%', 20)} | {pad_korean(f'{o_pprob:.1f}%', 20)} | {o_verdict}")
    print("="*115)

    print("\n[ 용어 설명 ]")
    print("■ 비강제수: 누구나 둬야 하는 뻔한 강제수(유일수 등)를 제외하고, 다양한 선택의 여지가 있는 수순입니다.")
    print("■ 난전 Top-1: 국면이 팽팽한 복잡한 상황(1~2순위 수 격차가 적은 경우)에서의 AI 1위수 일치율입니다.")
    print("■ 최고성능구간 ACPL: 비강제수 10수 단위로 쪼갰을 때 가장 점수 손실이 적었던(가장 AI와 유사했던) 구간의 평균 손실입니다.")
    print("■ 어려운 포지션 Top-1: AI 1위수와 2위수의 평가값 격차가 50 이하인 매우 난해한 승부처에서의 1위수 일치율입니다.")
    print("■ 치명적실수 직후 회복률: 200 이상 손해를 본 큰 실수 직후의 다음 3수가 완벽한 방어 수준(손실 10 이하)을 기록한 빈도입니다.")
    print("■ Top-5 선택 깔때기: Top-1 ➔ Top-3 ➔ Top-5로 확장 시 일치율 누적 추세(Funnel)로, 인간은 완만한 계단식을 이룹니다.")
    print("■ CP 근접도(Proximity): 둔 수가 최선수 평가치 대비 몇 cp 내에 머물렀는지를 지수 감쇄로 환산한 점수입니다.")

    print("\n[ AI 유사도 분석 결과 해석 가이드라인 ]")
    print("※ 본 리포트는 기보의 통계적 패턴을 수치화한 '유사도 참고 자료'이며, 단정적인 부정행위의 증거가 될 수 없습니다.")
    print("1. 승부처 일치율(Critical Match): 누구나 맞추는 당연한 수를 제외하고, 복잡한 난전에서 1위 수와")
    print("   일치하는 비율입니다. 최고수 프로 기사도 이 수치가 지속적으로 60%를 넘기기는 매우 어렵습니다.")
    print("2. 스파이크 감지(Spike Detection): 게임 전체 평균은 15~20 수준의 보편적 수치인데, 특정 위기 상황 등")
    print("   특정 10수 구간이나 3~6수 전술 버스트에서 주변 흐름과 다른 정밀도 상승이 반복될 때만 참고 신호로 봅니다.")
    print("3. 난이도 대비 정확도(Complexity Accuracy): 인간은 포지션이 복잡할수록 보통 정확도가 하락하지만,")
    print("   AI는 복잡성에 관계없이 항시 1위 수를 찾아냅니다. 어려운 포지션 일치율이 60%를 상회하면 유의미한 수치입니다.")
    print("4. 비대칭 분포 및 방어 회복: 누적 치명적실수(Blunder)는 0인데 의문수만 유독 많거나, 큰 실수를 한 직후")
    print("   심리적 흔들림 없이 갑자기 완벽한 최선의 수로만 방어한다면, 특이 패턴으로 분류될 수 있습니다.")
    print("5. 기복 및 편차(Variance): 일반적인 인간은 포지션에 따라 25~40 수준의 편차(기복)를 보입니다.")
    print("   만약 편차가 15 미만으로 극도로 일정하며 손실이 적다면, 시스템/AI 특유의 기계적 안정성과 유사합니다.")
    print("="*115)

def print_single_report(cho_moves: List[HistoryEntry], han_moves: List[HistoryEntry], stage_name: str, cho_name: str, han_name: str, use_db: bool, search_config: str) -> None:
    c_stats = calc_stats(cho_moves)
    h_stats = calc_stats(han_moves)
    c_adv = calc_advanced_stats(cho_moves)
    h_adv = calc_advanced_stats(han_moves)

    c_fprob, c_pprob, c_verdict = calculate_cheat_probability(cho_moves)
    h_fprob, h_pprob, h_verdict = calculate_cheat_probability(han_moves)
    c_burst_score, c_bursts, c_burst_verdict = calculate_tactical_burst(cho_moves)
    h_burst_score, h_bursts, h_burst_verdict = calculate_tactical_burst(han_moves)

    c_calib_full, c_calib_part, c_db_msg = calibrate_with_db(cho_name, c_fprob, c_pprob, c_stats, use_db, search_config)
    h_calib_full, h_calib_part, h_db_msg = calibrate_with_db(han_name, h_fprob, h_pprob, h_stats, use_db, search_config)

    def re_evaluate_verdict(f_prob, p_prob):
        max_prob = max(f_prob, p_prob)
        if max_prob >= 90.0: return "🔴 일치도가 극도로 높은 이례적인 통계적 특이성"
        if max_prob >= 70.0: return "🟡 정밀 검토가 요구되는 높은 정교함 및 기계적 연관성"
        if max_prob >= 40.0: return "🟠 최상위권 프로 및 고수 수준의 정교한 대국 내용"
        return "🟢 자연스러운 인간 대국자의 흐름 및 편차"

    if use_db:
        c_verdict = re_evaluate_verdict(c_calib_full, c_calib_part)
        h_verdict = re_evaluate_verdict(h_calib_full, h_calib_part)

    def format_phase(moves, start, end):
        val = get_numeric_phase_acpl(moves, start, end)
        return f"{val:.1f}" if val is not None else "-"

    print("\n" + "="*115)
    print(pad_korean(f"장기 기보 AI 유사도 프로파일링 리포트 (단일 기보) - {stage_name}", 115))
    print("="*115)

    if use_db:
        print("\n 💬 [ 플레이어 성향 상세 분석 (Narrative Report) ]")
        print("-" * 115)
        print(f" ▶ 초(Red) [{cho_name if cho_name else '익명'}]:")
        print(get_playstyle_narrative(cho_name, search_config, cho_moves))
        print(f"\n ▶ 한(Grn) [{han_name if han_name else '익명'}]:")
        print(get_playstyle_narrative(han_name, search_config, han_moves))
        print("-" * 115)

    print("\n [ 초 (Red) 진영 실시간 형세 추세 시각화 (Evaluation Curve) ]")
    print(generate_ascii_eval_curve(cho_moves))
    print("\n [ 한 (Grn) 진영 실시간 형세 추세 시각화 (Evaluation Curve) ]")
    print(generate_ascii_eval_curve(han_moves))
    print("-" * 115)

    print(f"\n [ 핵심 지표 (강제수 필터링 & MultiPV=5 순위 확장 적용) ]")
    header = f" {pad_korean('진영', 10)} | {pad_korean('전체ACPL', 11)} | {pad_korean('비강제ACPL', 12)} | {pad_korean('편차(기복)', 11)} | {pad_korean('전체Top-3', 11)} | {pad_korean('전체Top-5', 11)} | {pad_korean('비강제Top-1', 12)} | {pad_korean('난전Top-1', 11)}"
    print(header)
    print("-" * 115)
    for name, s in [("초(Red)", c_stats), ("한(Grn)", h_stats)]:
        row = f" {pad_korean(name, 10)} | {s[0]:11.2f} | {s[11]:12.2f} | {s[8]:11.2f} | {pad_korean(f'{s[2]:.1f}%', 11)} | {pad_korean(f'{s[3]:.1f}%', 11)} | {pad_korean(f'{s[10]:.1f}%', 12)} | {pad_korean(f'{s[9]:.1f}%', 11)}"
        print(row)

    print("\n [ 세분화된 수순 평가 ]")
    header2 = f" {pad_korean('진영', 10)} | {pad_korean('완벽수(≤5cp)', 14)} | {pad_korean('의문수(50~99)', 14)} | {pad_korean('일반실수(100~199)', 14)} | {pad_korean('치명적실수(≥200)', 14)}"
    print(header2)
    print("-" * 115)
    for name, s in [("초(Red)", c_stats), ("한(Grn)", h_stats)]:
        row = f" {pad_korean(name, 10)} | {pad_korean(f'{s[4]} 회', 14)} | {pad_korean(f'{s[5]} 회', 14)} | {pad_korean(f'{s[6]} 회', 14)} | {pad_korean(f'{s[7]} 회', 14)}"
        print(row)

    print("\n [ 구간별 점수 손실 (Phase Analysis) ] *(후반부 AI 평가치 변동 보정용)*")
    header3 = f" {pad_korean('진영', 10)} | {pad_korean('초반 (1~30수)', 28)} | {pad_korean('중반 (31~70수)', 28)} | {pad_korean('종반 (71수 이후)', 28)}"
    print(header3)
    print("-" * 115)
    for name, m in [("초(Red)", cho_moves), ("한(Grn)", han_moves)]:
        row = f" {pad_korean(name, 10)} | {pad_korean(format_phase(m, 0, 29), 28)} | {pad_korean(format_phase(m, 30, 69), 28)} | {pad_korean(format_phase(m, 70, 999), 28)}"
        print(row)

    print("\n [ 특정 구간 AI 밀착도 심층 지표 ]")
    header4 = f" {pad_korean('진영', 10)} | {pad_korean('최고성능구간(10수) ACPL', 26)} | {pad_korean('어려운 포지션(격차<50) Top-1', 30)} | {pad_korean('치명적실수 직후(3수) 회복률', 30)}"
    print(header4)
    print("-" * 115)
    for name, a in [("초(Red)", c_adv), ("한(Grn)", h_adv)]:
        row = f" {pad_korean(name, 10)} | {pad_korean(format_adv_metric(a[0]), 26)} | {pad_korean(format_adv_metric(a[1], True), 30)} | {pad_korean(format_adv_metric(a[2], True), 30)}"
        print(row)

    print_candidate_profile_report({"초(Red)": cho_moves, "한(Grn)": han_moves})
    print_suspicious_segments_report(cho_moves, "초(Red)")
    print_suspicious_segments_report(han_moves, "한(Grn)")
    print_local_correlation_report({"초(Red)": cho_moves, "한(Grn)": han_moves})

    print_tactical_burst_details([
        ("초(Red)", c_burst_score, c_bursts, c_burst_verdict),
        ("한(Grn)", h_burst_score, h_bursts, h_burst_verdict),
    ])

    print("="*115)
    print(pad_korean("[ 종합 참고 소견 (Reference Verdict) ]", 115))
    print("-" * 115)
    if use_db:
        print(f" {pad_korean('진영', 10)} | {pad_korean('전체 유사도 (수학➔DB보정)', 30)} | {pad_korean('구간 유사도 (수학➔DB보정)', 30)} | 통계적 분석 소견")
        print("-" * 115)
        c_full_str = f"{c_fprob:.1f}% ➔ {c_calib_full:.1f}%"
        c_part_str = f"{c_pprob:.1f}% ➔ {c_calib_part:.1f}%"
        print(f" {pad_korean('초(Red)', 10)} | {pad_korean(c_full_str, 30)} | {pad_korean(c_part_str, 30)} | {c_verdict}{c_db_msg}")
        h_full_str = f"{h_fprob:.1f}% ➔ {h_calib_full:.1f}%"
        h_part_str = f"{h_pprob:.1f}% ➔ {h_calib_part:.1f}%"
        print(f" {pad_korean('한(Grn)', 10)} | {pad_korean(h_full_str, 30)} | {pad_korean(h_part_str, 30)} | {h_verdict}{h_db_msg}")
    else:
        print(f" {pad_korean('진영', 10)} | {pad_korean('전체 AI 유사도', 20)} | {pad_korean('구간 AI 유사도', 20)} | 통계적 분석 소견")
        print("-" * 115)
        print(f" {pad_korean('초(Red)', 10)} | {pad_korean(f'{c_fprob:.1f}%', 20)} | {pad_korean(f'{c_pprob:.1f}%', 20)} | {c_verdict}")
        print(f" {pad_korean('한(Grn)', 10)} | {pad_korean(f'{h_fprob:.1f}%', 20)} | {pad_korean(f'{h_pprob:.1f}%', 20)} | {h_verdict}")
    print("="*115)

    print("\n[ 용어 설명 ]")
    print("■ 비강제수: 누구나 둬야 하는 뻔한 강제수(유일수 등)를 제외하고, 다양한 선택의 여지가 있는 수순입니다.")
    print("■ 난전 Top-1: 국면이 팽팽한 복잡한 상황(1~2순위 수 격차가 적은 경우)에서의 AI 1위수 일치율입니다.")
    print("■ 최고성능구간 ACPL: 비강제수 10수 단위로 쪼갰을 때 가장 점수 손실이 적었던(가장 AI와 유사했던) 구간의 평균 손실입니다.")
    print("■ 어려운 포지션 Top-1: AI 1위수와 2위수의 평가값 격차가 50 이하인 매우 난해한 승부처에서의 1위수 일치율입니다.")
    print("■ 치명적실수 직후 회복률: 200 이상 손해를 본 큰 실수 직후의 다음 3수가 완벽한 방어 수준(손실 10 이하)을 기록한 빈도입니다.")
    print("■ Top-5 선택 깔때기: Top-1 ➔ Top-3 ➔ Top-5로 확장 시 일치율 누적 추세(Funnel)로, 인간은 완만한 계단식을 이룹니다.")
    print("■ CP 근접도(Proximity): 둔 수가 최선수 평가치 대비 몇 cp 내에 머물렀는지를 지수 감쇄로 환산한 점수입니다.")

    print("\n[ 장기 AI 유사도 판독 가이드라인 (전체 게임) ]")
    print("※ 본 리포트는 기보의 통계적 패턴을 수치화한 '유사도 참고 자료'이며, 단정적인 부정행위의 증거가 될 수 없습니다.")
    print("1. 비강제 ACPL  0 ~ 10 : 매우 기계적이고 완벽한 일치 범위 (Superhuman 범주)")
    print("2. 비강제 ACPL 10 ~ 20 : 최상위 프로 기사 및 고도로 훈련된 전문가 수준")
    print("3. 비강제 ACPL 20 ~ 40 : 일반적인 고수 ~ 아마추어 수준")
    print("4. 후보수 제한이 많은 장기 특성상, 최고수도 Top-3 일치율 70~80%대에 도달할 수 있습니다.")
    print("   다만, 비강제 Top-1 일치율이 70%를 넘거나, 전체 단일 일치율이 90% 이상이라면 AI와의 높은 유사성을 보입니다.")
    print("5. 기복 및 편차(Variance): 일반적인 인간은 포지션에 따라 25~40 수준의 편차(기복)를 보입니다.")
    print("   만약 편차가 15 미만으로 극도로 일정하며 손실이 적다면, 시스템/AI 특유의 기계적 안정성과 유사합니다.")

    print("\n[ 국지적 AI 밀착도 (Partial Match) 패턴 가이드라인 ]")
    print("1. 인간 최고수는 보통 편차(Variance)가 25~40 수준을 기록하지만, AI는 10~20대의 극단적 안정성을 보입니다.")
    print("   기복(편차) 지표가 15 미만으로 이례적으로 낮다면 전반적인 기계적 일관성 여부를 검토해볼 수 있습니다.")
    print("2. 구간별/스파이크 분석에서, 복잡한 '중반(Midgame)'의 손실이 한 자릿수를 기록하거나 특정 10수 구간 또는 3~6수 전술 버스트가")
    print("   주변 흐름보다 뚜렷하게 정밀하다면 난전 구간 검토용 참고 신호로만 해석합니다.")
    print("3. 큰 실수 직후 회복: 치명적인 실수를 한 직후 인간 특유의 연속 실수 없이 갑자기 완벽에 가까운 3수(ACPL<10)를")
    print("   찾아낸다면, 위기 상황에서 외부의 통계적/기계적 도움과 일치하는 흐름으로 해석될 수 있습니다.")
    print("="*115)

def print_final_comparison_summary(all_stages_data: List[dict]):
    print("\n\n" + "!"*135)
    print(pad_korean("★ [ 다중 단계 교차 분석 종합 요약표 (Summary) ] ★", 135))
    print("!"*135)
    header = f" {pad_korean('검증 단계', 25)} | {pad_korean('비강제ACPL', 11)} | {pad_korean('비강제Top-1', 11)} | {pad_korean('난전Top-1', 11)} | {pad_korean('편차', 9)} | {pad_korean('최고 유사도', 11)} | 통계적 분석 소견"
    print(header)
    print("-" * 135)
    for data in all_stages_data:
        name = data['name']
        for side_name, moves in data['results'].items():
            s = calc_stats(moves)
            f_p, p_p, verdict = calculate_cheat_probability(moves)
            display_name = f"[{side_name}] {name}"
            row = f" {pad_korean(display_name, 25)} | {s[11]:11.2f} | {pad_korean(f'{s[10]:.1f}%', 11)} | {pad_korean(f'{s[9]:.1f}%', 11)} | {s[8]:9.2f} | {pad_korean(f'{max(f_p, p_p):.1f}%', 11)} | {verdict}"
            print(row)
    print("\n" + "="*135)
    print(pad_korean("[ 교차 분석 판정 핵심 참고사항 ]", 135))
    print("-" * 135)
    print(" 1. 모델 시그니처 감지: 특정 단계에서만 일치율이 60~70% 이상으로 솟구친다면, 해당 계열의 AI와 일치할 가능성이 높습니다.")
    print(" 2. 비강제 ACPL: 초고수 프로 기사도 보통 15~25 수준을 보입니다. 10 이하가 지속된다면 기계적 개입의 강력한 통계적 지표가 됩니다.")
    print(" 3. 국지적 집중: 중반(31~70수) 손실이 한 자릿수이면서 편차가 20 미만인 경우, 결정적인 순간에 매우 높은 AI 일치도를 보인 것입니다.")
    print(" 4. 기복 분석: 대국자는 난전에서 필연적으로 기복(편차 30↑)이 발생합니다. 일관된 낮은 편차는 AI의 전형적인 통계적 특징입니다.")
    print("="*135)

def write_csv_log(filename: str, history: List[HistoryEntry]):
    try:
        with open(filename, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            writer.writerow(['Game_ID', 'Ply', 'Move', 'Played_UCI', 'Best_UCI', 'Rank', 'Is_Top_5', 'CP_Proximity', 'Loss(cp)', 'Is_Forced', 'Is_Critical', 'Eval_Gap', 'Entropy', 'Empirical_LLR', 'Rank_Weighted_Match'])
            for h in history:
                llr_val = get_empirical_binned_llr(h.eval_gap, h.eval_loss)
                writer.writerow([
                    h.game_id, h.ply+1, h.san, h.uci, h.best_move, 
                    h.engine_rank, 1 if h.is_top_5 else 0, f'{h.cp_proximity:.1f}',
                    h.eval_loss, h.is_forced, h.is_critical, h.eval_gap, 
                    f'{h.entropy:.3f}', f'{llr_val:.2f}', f'{_rank_weighted_match(h):.2f}'
                ])
        print(f"\n[안내] 상세 분석 로그가 CSV 파일({filename})로 저장되었습니다.")
    except Exception as e:
        print(f"\n[오류] CSV 파일 저장 실패: {e}")

def run_files_analysis(inputs, engine_path, depth, nodes, nnue_path, aux_nnues, use_nnue, threads, is_single_no_target, log_prefix="", force_reanalyze=False, repeat=1):
    cho_moves_all, han_moves_all, target_moves_all, opp_moves_all = [], [], [], []
    white_name, black_name = "", ""

    for i, item in enumerate(inputs, 1):
        if ":" in item:
            file_path, side = item.rsplit(":", 1)
            side = side.lower()
        else:
            file_path, side = item, "both" if is_single_no_target else "cho"

        input_text = Path(file_path).read_text(encoding="utf-8")
        if i == 1: white_name, black_name = extract_player_names(input_text)
        
        game_history = analyze_game(engine_path, input_text, depth, nodes, nnue_path, aux_nnues, use_nnue, threads, log_prefix, game_id=i, force_reanalyze=force_reanalyze, repeat=repeat)
        
        if is_single_no_target:
            cho_moves_all.extend([h for h in game_history if h.ply % 2 == 0])
            han_moves_all.extend([h for h in game_history if h.ply % 2 != 0])
        else:
            if side == "cho":
                target_moves_all.extend([h for h in game_history if h.ply % 2 == 0])
                opp_moves_all.extend([h for h in game_history if h.ply % 2 != 0])
            else:
                target_moves_all.extend([h for h in game_history if h.ply % 2 != 0])
                opp_moves_all.extend([h for h in game_history if h.ply % 2 == 0])

    return cho_moves_all, han_moves_all, target_moves_all, opp_moves_all, white_name, black_name

def evaluate_single_nnue(nnue_path: Path, engine_path: Path, depth: int, nodes: Optional[int], test_targets: List[HistoryEntry]) -> Tuple[str, List[Tuple[str, List[str]]]]:
    engine = EngineSession(engine_path, depth, nodes, str(nnue_path), True, 1)
    preds = []
    for tgt in test_targets:
        top_moves, _ = engine.get_top_moves(tgt.start_fen)
        top_ucis = [m.uci for m in top_moves]
        t1 = top_ucis[0] if top_ucis else ""
        preds.append((t1, top_ucis))
    engine.close()
    return (nnue_path.name, preds)

def run_fingerprinting(engine_path: Path, nnue_dir: str, depth: int, nodes: Optional[int], threads: int, target_moves: List[HistoryEntry], target_name: str):
    nnue_files = list(Path(nnue_dir).glob("*.nnue"))
    if not nnue_files:
        print(f"\n[오류] 지정한 폴더({nnue_dir})에서 NNUE 파일을 찾을 수 없습니다.")
        return

    candidates = [m for m in target_moves if not m.is_forced and m.eval_loss <= 5 and m.ply >= 12]
    candidates.sort(key=lambda m: m.eval_gap)
    test_targets = candidates[:min(100, max(30, len(candidates) // 3))] 

    if not test_targets:
        print(f"\n[안내] {target_name}의 기보에는 유사 모델을 특정할 만한 복잡한 완벽수가 충분하지 않습니다.")
        return

    print("\n" + "="*105)
    print(pad_korean(f"★ [ 심층 분석: NNUE 핑거프린팅 (유사 모델 추적) ] - 대상: {target_name} ★", 105))
    print("="*105)
    print(f" 발견된 교차 검증용 NNUE 파일: {len(nnue_files)}개")
    print(f" 1차 추출된 변별력 높은 핵심 수순(Hard-Perfect Moves): {len(test_targets)}개")
    
    engine_results = {}
    max_workers = min(len(nnue_files), max(1, threads // 2))
    print(" 다중 스레드를 통한 고속 핑거프린팅 분석 진행 중... (기다려 주십시오)", end='\r')
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(evaluate_single_nnue, nnue, engine_path, depth, nodes, test_targets) for nnue in nnue_files]
        for idx, future in enumerate(as_completed(futures), 1):
            name, preds = future.result()
            engine_results[name] = preds
            print(f" 병렬 분석 진행 중... [{idx}/{len(nnue_files)}] 완료              ", end='\r')

    valid_divergent_indices = []
    for i in range(len(test_targets)):
        t1_set = {engine_results[nnue_name][i][0] for nnue_name in engine_results}
        if len(t1_set) > 1: valid_divergent_indices.append(i)

    divergent_count = len(valid_divergent_indices)
    is_divergent_mode = True
    if divergent_count == 0:
        valid_divergent_indices = list(range(len(test_targets)))
        divergent_count = len(valid_divergent_indices)
        is_divergent_mode = False

    if is_divergent_mode:
        print(f"\n ➔ 모델 간 편차가 존재하는(변별력 높은) 특이 수순: {divergent_count}개 필터링 완료")
    else:
        print("\n")
    print(" 유사 모델 추적 완료!                                       \n")

    results = {}
    max_possible_score = divergent_count * 3
    for nnue_name, preds in engine_results.items():
        t1_match = sum(1 for i in valid_divergent_indices if test_targets[i].uci == preds[i][0])
        t3_match = sum(1 for i in valid_divergent_indices if test_targets[i].uci in preds[i][1][:3])
        weighted_score = 0
        for i in valid_divergent_indices:
            tgt_uci = test_targets[i].uci
            t3_list = preds[i][1][:3]
            if tgt_uci in t3_list:
                rank = t3_list.index(tgt_uci)
                weighted_score += (3 if rank == 0 else (2 if rank == 1 else 1))
        t1_rate = (t1_match / divergent_count) * 100 if divergent_count > 0 else 0.0
        t3_rate = (t3_match / divergent_count) * 100 if divergent_count > 0 else 0.0
        match_index = (weighted_score / max_possible_score) * 100 if max_possible_score > 0 else 0.0
        results[nnue_name] = (match_index, t1_rate, t3_rate)
    
    sorted_res = sorted(results.items(), key=lambda x: (x[1][0], x[1][1]), reverse=True)
    print(f" {pad_korean('NNUE 파일명', 35)} | {pad_korean('유사도 지수(종합)', 20)} | {pad_korean('Top-1 일치율', 15)} | {pad_korean('Top-3 포함률', 15)}")
    print("-" * 105)
    for nnue_name, (match_idx, t1_rate, t3_rate) in sorted_res:
        row = f" {pad_korean(nnue_name, 35)} | {pad_korean(f'{match_idx:.1f} 점', 20)} | {pad_korean(f'{t1_rate:.1f}%', 15)} | {pad_korean(f'{t3_rate:.1f}%', 15)}"
        print(row)
    print("="*105)

    f_prob, p_prob, _ = calculate_cheat_probability(target_moves)
    suspicion_level = max(f_prob, p_prob)
    top_match_idx = sorted_res[0][1][0] if sorted_res else 0
    top_nnue = sorted_res[0][0] if sorted_res else ""

    print(pad_korean("[ 핑거프린팅 종합 소견 참고사항 ]", 105))
    print("-" * 105)
    if suspicion_level < 60:
        print(" 🟢 대상의 전반적인 대국 지표가 일반적인 인간의 범주에 속합니다.")
        print("    (위 일치율은 특정 모델을 참고했다기보다는 대국자의 우수한 수읽기 결과일 가능성이 높습니다.)")
    else:
        if top_match_idx >= 80.0:
            print(f" 🔴 대상 기보에서 AI 특유의 수순 전개와 짙은 유사성이 나타나며,")
            print(f"    검토된 파일 중 [{top_nnue}] 모델(또는 동종 계열)과 가장 높은 상관관계를 보입니다.")
            print(f"    (대국 시 해당 모델의 추천수를 참고했을 가능성이 통계적으로 유의미합니다.)")
        else:
            print(" 🟠 대상 기보에서 AI와의 유사 패턴이 일부 관찰되나,")
            print("    제공된 NNUE 목록 중 특정 모델을 명확히 지목할 만큼 두드러지는 특이점은 나타나지 않았습니다.")
    print("="*105)

    print("\n[ 핑거프린팅 결과 해석 가이드 ]")
    print(" ■ 유사도 지수(종합): 단순 1위 적중률의 맹점을 보완하기 위해 1위(3점), 2위(2점), 3위(1점)의 가중치를")
    print("   부여하여 100점 만점으로 환산한 점수입니다. Top-1 일치율보다 안정적이고 신뢰도가 높습니다.")
    print(" ■ 탐색 깊이나 멀티스레드 환경에 따라 엔진의 1위 수가 미세하게 변동될 수 있으므로,")
    print("   단순히 1위 일치율(Top-1)만 보기보다는 상위 후보군(Top-3) 포함률을 함께 고려해야 합니다.")
    print(" ■ 단일 파일의 순위보다는 '유사도 지수'가 상위권에 몰려있는 모델 그룹 전체를")
    print("   대국 당시 가장 밀접하게 참고되었을 가능성이 있는 엔진 계열로 해석하는 것이 권장됩니다.")
    print("="*105)

def prompt_label_for_anonymous(side_name: str) -> Optional[Tuple[int, str]]:
    print(f"\n[DB 라벨링] 기보에 '{side_name}' 진영의 닉네임이 없습니다.")
    print("이 대국자의 판독 결과를 입력하여 DB 판단 기준을 정밀하게 학습시킬 수 있습니다.")
    print("  1: 기계적 의심 높음 (Definite/High Machine Suspect)")
    print("  2: 기계적 의심 보통 (Suspected Machine)")
    print("  3: 사람으로 추정 (Likely Human)")
    print("  4: 사람으로 확신 (Definite Human)")
    print("  엔터: 건너뛰기")
    
    while True:
        try:
            choice = input("선택 (1/2/3/4 또는 엔터): ").strip()
            if not choice: return None
            val = int(choice)
            if val == 1: return (1, "기계적 의심 높음")
            elif val == 2: return (2, "기계적 의심 보통")
            elif val == 3: return (3, "사람 추정")
            elif val == 4: return (4, "사람 확신")
            print("잘못된 입력입니다. 1~4 사이의 숫자를 입력하세요.")
        except ValueError:
            print("숫자를 입력해주세요.")

def main(argv: Optional[Sequence[str]] = None) -> int:
    init_db()
    parser = argparse.ArgumentParser(description="FJACE Analyzer v12.3 (Top-5 + Multi-scale Windows)")
    parser.add_argument("inputs", nargs='+', help="Path to PGN files. 'filename:cho' or 'filename:han'")
    parser.add_argument("--engine", default="./stockfish.exe", help="Path to engine")
    parser.add_argument("--depth", type=int, default=15, help="Search depth")
    parser.add_argument("--nodes", type=int, default=None, help="Search nodes")
    parser.add_argument("--nnue", default=None, help="Main NNUE")
    parser.add_argument("--nnue2", default=None, help="Secondary NNUE")
    parser.add_argument("--threads", type=int, default=1, help="Threads")
    parser.add_argument("--auto-deep", action="store_true", help="Auto deep analysis")
    parser.add_argument("--deep-add", type=int, default=5, help="Deep depth add")
    parser.add_argument("--deep-mult", type=float, default=2.0, help="Deep node mult")
    parser.add_argument("--force-3stage", action="store_true", help="Force classic HCE")
    parser.add_argument("--aux-dir", default=None, help="Aux NNUE dir")
    parser.add_argument("--fingerprint-dir", default=None, help="Fingerprint NNUE dir")
    parser.add_argument("--csv", default=None, help="CSV output path")
    parser.add_argument("--db", action="store_true", help="Enable DB profiling")
    parser.add_argument("--range", default=None, help="Ply range (e.g. 30:70)")
    parser.add_argument("--repeat", type=int, default=1, help="Repetitions (1, 3, 5)")
    parser.add_argument("--force-reanalyze", action="store_true", help="Bypass DB cache")
    args = parser.parse_args(argv)

    if args.repeat not in (1, 3, 5):
        print("--repeat must be 1, 3, or 5")
        return 1

    engine_path = Path(args.engine)
    if not engine_path.exists(): raise SystemExit(f"Engine not found: {engine_path}")

    is_single_no_target = (len(args.inputs) == 1 and ":" not in args.inputs[0])
    current_search_config = get_search_config(args.depth, args.nodes)

    aux_nnues_for_consensus = []
    if args.aux_dir and Path(args.aux_dir).exists():
        all_aux = list(Path(args.aux_dir).glob("*.nnue"))
        main_name = Path(args.nnue).name if args.nnue else ""
        aux_nnues_for_consensus = [str(p) for p in all_aux if p.name != main_name][:2]
        if aux_nnues_for_consensus:
            print(f"\n[알림] {args.aux_dir} 폴더에서 {len(aux_nnues_for_consensus)}개의 앵커 NNUE를 합의(Consensus) 보조 패널로 가동합니다.")
    elif args.nnue2 and Path(args.nnue2).exists():
        aux_nnues_for_consensus = [args.nnue2]
        print(f"\n[알림] --nnue2 에 지정된 {Path(args.nnue2).name} 파일을 합의(Consensus) 단일 보조 패널로 사용합니다.")

    if args.db:
        print(f"\n[DB 모드 활성화] 현재 탐색 환경 '{current_search_config}' 기준으로 DB를 로드/저장합니다.")

    stages = [
        {"num": 1, "nnue": args.nnue, "use": True, "name": "1단계 (최신 NNUE)"},
        {"num": 2, "nnue": args.nnue2, "use": True, "name": "2단계 (보조 NNUE)"},
        {"num": 3, "nnue": None, "use": False, "name": "3단계 (HCE/클래식)"}
    ]

    all_stages_data = []
    stages_run = 0
    cho_all, han_all, target_all, opp_all = [], [], [], []
    white_name, black_name = "", ""

    start_ply, end_ply = 1, 999
    if args.range:
        try:
            sp, ep = args.range.split(":")
            start_ply = int(sp) if sp else 1
            end_ply = int(ep) if ep else 999
            print(f"[안내] 지정된 Move Range ({start_ply}수 ~ {end_ply}수) 범위 내의 수순만 필터링하여 보고서를 구성합니다.")
        except ValueError:
            print("[오류] --range 형식 오류 (예: 30:70)")

    for stage in stages:
        if stage["num"] == 2 and not args.nnue2: continue
        if stage["num"] == 3 and not args.force_3stage:
            print("\n[안내] 3단계(클래식 분석)는 통계적 기준이 크게 다르므로 기본적으로 생략됩니다. (--force-3stage 옵션으로 강제 실행 가능)")
            break

        print(f"\n\n" + "#"*70)
        print(f"### [ {stage['name']} 분석 가동 ]")
        print("#"*70)

        cho_raw, han_raw, target_raw, opp_raw, w_n, b_n = run_files_analysis(
            args.inputs, engine_path, args.depth, args.nodes, stage["nnue"], aux_nnues_for_consensus, stage["use"], args.threads, is_single_no_target, force_reanalyze=args.force_reanalyze, repeat=args.repeat
        )
        if stage["num"] == 1: white_name, black_name = w_n, b_n

        cho_all = analyze_move_range(cho_raw, start_ply, end_ply)
        han_all = analyze_move_range(han_raw, start_ply, end_ply)
        target_all = analyze_move_range(target_raw, start_ply, end_ply)
        opp_all = analyze_move_range(opp_raw, start_ply, end_ply)

        if is_single_no_target:
            cf, cp, _ = calculate_cheat_probability(cho_all)
            hf, hp, _ = calculate_cheat_probability(han_all)
            max_prob = max(cf, cp, hf, hp)
        else:
            tf, tp, _ = calculate_cheat_probability(target_all)
            max_prob = max(tf, tp)

        if args.auto_deep and 60 <= max_prob < 85:
            print(f"\n\n[안내] 통계적 특이점 구간 감지 (최고 유사도 {max_prob:.1f}%): 현재 엔진에서 심층 재분석을 시도합니다.")
            deep_depth = args.depth + args.deep_add
            deep_nodes = int(args.nodes * args.deep_mult) if args.nodes else None
            current_search_config = get_search_config(deep_depth, deep_nodes)
            cho_raw, han_raw, target_raw, opp_raw, _, _ = run_files_analysis(
                args.inputs, engine_path, deep_depth, deep_nodes, stage["nnue"], aux_nnues_for_consensus, stage["use"], args.threads, is_single_no_target, log_prefix="[심층 탐색] ", force_reanalyze=args.force_reanalyze, repeat=args.repeat
            )
            cho_all = analyze_move_range(cho_raw, start_ply, end_ply)
            han_all = analyze_move_range(han_raw, start_ply, end_ply)
            target_all = analyze_move_range(target_raw, start_ply, end_ply)
            opp_all = analyze_move_range(opp_raw, start_ply, end_ply)

            if is_single_no_target:
                cf, cp, _ = calculate_cheat_probability(cho_all)
                hf, hp, _ = calculate_cheat_probability(han_all)
                max_prob = max(cf, cp, hf, hp)
            else:
                tf, tp, _ = calculate_cheat_probability(target_all)
                max_prob = max(tf, tp)

        if is_single_no_target:
            print_single_report(cho_all, han_all, stage["name"], white_name, black_name, args.db, current_search_config)
            stage_results = {"name": stage["name"], "results": {"초(Red)": cho_all, "한(Grn)": han_all}}
        else:
            print_target_report(target_all, opp_all, len(args.inputs), stage["name"], args.db, current_search_config)
            stage_results = {"name": stage["name"], "results": {"타겟(분석)": target_all, "상대방(평균)": opp_all}}

        all_stages_data.append(stage_results)
        stages_run += 1
        
        if args.force_3stage:
            print(f"\n[안내] 강제 3단계 모드 활성화: 다음 분석 모델로 교차 검증을 계속합니다.")
            continue

        if stage["num"] == 1:
            if 70 <= max_prob < 85:
                print(f"\n[안내] 보수적 교차 분석: 통계적 유사도가 경계선에 위치하여({max_prob:.1f}%), 2단계(보조 모델) 검증을 추가로 시도합니다.")
            elif max_prob >= 85:
                print(f"\n[안내] AI 패턴과의 유사도가 매우 높게 측정되었습니다({max_prob:.1f}%). 1단계 판독만으로 분석을 조기 종료합니다.")
                break
            else:
                print(f"\n[안내] 판독 결과 일반적인 대국 범주에 부합하여 분석을 조기 종료합니다.")
                break
        elif stage["num"] == 2:
            break

    if is_single_no_target and args.db and all_stages_data:
        stage1_data = all_stages_data[0]['results']
        cho_m, han_m = stage1_data["초(Red)"], stage1_data["한(Grn)"]
        c_stats, h_stats = calc_stats(cho_m), calc_stats(han_m)

        print("\n" + "="*105)
        print(pad_korean("[ DB 통계 누적 시스템 ]", 105))
        if white_name: update_player_profile(white_name, c_stats, [m.uci for m in cho_m[:6]], current_search_config)
        else:
            ans = prompt_label_for_anonymous("초(Red)")
            if ans: update_labeled_stats(ans[0], ans[1], c_stats, current_search_config)
        if black_name: update_player_profile(black_name, h_stats, [m.uci for m in han_m[:6]], current_search_config)
        else:
            ans = prompt_label_for_anonymous("한(Grn)")
            if ans: update_labeled_stats(ans[0], ans[1], h_stats, current_search_config)
        print("="*105)

    if stages_run > 1: print_final_comparison_summary(all_stages_data)
    
    if args.fingerprint_dir and all_stages_data:
        stage1_data = all_stages_data[0]['results']
        if is_single_no_target:
            cho_moves = stage1_data["초(Red)"]
            han_moves = stage1_data["한(Grn)"]
            cho_prob = max(calculate_cheat_probability(cho_moves)[0:2])
            han_prob = max(calculate_cheat_probability(han_moves)[0:2])
            
            fp_targets = []
            if cho_prob >= 60.0: fp_targets.append(("초(Red)", cho_moves))
            if han_prob >= 60.0: fp_targets.append(("한(Grn)", han_moves))
            
            if not fp_targets:
                print("\n[안내] 두 진영 모두 AI 유사도가 비교적 낮아 핑거프린팅 분석의 실효성이 떨어지지만, 분석 요청에 의해 상대적으로 수치가 높은 진영을 1회 검사합니다.")
                if cho_prob >= han_prob: fp_targets.append(("초(Red)", cho_moves))
                else: fp_targets.append(("한(Grn)", han_moves))
                    
            for name, moves in fp_targets:
                run_fingerprinting(engine_path, args.fingerprint_dir, args.depth, args.nodes, args.threads, moves, name)
        else:
            fp_target_moves = stage1_data["타겟(분석)"]
            run_fingerprinting(engine_path, args.fingerprint_dir, args.depth, args.nodes, args.threads, fp_target_moves, "타겟(분석)")

    if args.csv:
        all_history = sorted((cho_all + han_all) if is_single_no_target else (target_all + opp_all), key=lambda x: x.ply)
        write_csv_log(args.csv, all_history)
        
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
