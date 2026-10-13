import type { AccountStorage } from './account/storage';
import { MATCH_HISTORY_KEY, TRAINING_PROGRESS_KEY } from './account/cloud-saves';
import type { GameView } from './types';
import type { MatchReviewData } from './components/MatchReview';

export interface SavedBattle {
  gameId: string;
  review: MatchReviewData;
  playerLeader: string;
  opponentLeader: string;
  difficulty: string;
  startedAt: number;
  completedAt: number;
}

const lessonIds = ['resources', 'space-ambush', 'leader-deploy'];
export const DELETED_BATTLES_KEY = 'swu-command-deleted-battle-reviews';
const MAX_DELETED_BATTLES = 1000;
const battleId = (id: unknown): id is string => typeof id === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
function read(storage: AccountStorage, key: string): unknown {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}
function readDeletedBattles(storage: AccountStorage): string[] {
  try {
    const raw = storage.getItem(DELETED_BATTLES_KEY);
    if (!raw || raw.length > MAX_DELETED_BATTLES * 64 + 128) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.slice(0, MAX_DELETED_BATTLES).filter(battleId))];
  } catch { return []; }
}
export function isBattleDeleted(storage: AccountStorage, id: string): boolean {
  return battleId(id) && readDeletedBattles(storage).includes(id);
}
export function readBattleHistory(storage: AccountStorage): SavedBattle[] {
  const value = read(storage, MATCH_HISTORY_KEY);
  if (!Array.isArray(value)) return [];
  const deleted = new Set(readDeletedBattles(storage));
  return value.filter((item): item is SavedBattle => !!item && typeof item === 'object'
    && typeof item.gameId === 'string' && /^[a-f0-9-]{36}$/i.test(item.gameId)
    && !deleted.has(item.gameId)
    && Number.isFinite(item.completedAt) && typeof item.playerLeader === 'string' && typeof item.opponentLeader === 'string'
    && item.review?.version === 1 && ['win', 'loss', 'draw'].includes(item.review.outcome)
    && Array.isArray(item.review.moments) && !!item.review.stats)
    .sort((a, b) => b.completedAt - a.completedAt).slice(0, 50);
}
export function rememberBattle(storage: AccountStorage, game: GameView): SavedBattle[] {
  const previous = readBattleHistory(storage);
  if (!game.review || !game.winnerIds.length || game.training || !battleId(game.id) || isBattleDeleted(storage, game.id)) return previous;
  const existing = previous.find(item => item.gameId === game.id);
  const saved: SavedBattle = {
    gameId: game.id, review: game.review,
    playerLeader: game.players.human.leader.name || '', opponentLeader: game.players.bot.leader.name || '',
    difficulty: game.difficulty || 'normal', startedAt: game.startedAt || existing?.startedAt || Date.now(),
    completedAt: game.finishedAt || existing?.completedAt || Date.now(),
  };
  const next = [saved, ...previous.filter(item => item.gameId !== game.id)].slice(0, 50);
  try { storage.setItem(MATCH_HISTORY_KEY, JSON.stringify(next)); } catch { /* The current review remains visible. */ }
  return next;
}
export function removeBattle(storage: AccountStorage, id: string): SavedBattle[] {
  if (!battleId(id)) throw new Error('Invalid battle review.');
  // Persist deletion intent before editing history, so a resumed finished game
  // or a stale hydrated history cannot add this review again after a reload.
  const deleted = [id, ...readDeletedBattles(storage).filter(previous => previous !== id)].slice(0, MAX_DELETED_BATTLES);
  storage.setItem(DELETED_BATTLES_KEY, JSON.stringify(deleted));
  const next = readBattleHistory(storage).filter(item => item.gameId !== id);
  storage.setItem(MATCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}
export function readCompletedLessons(storage: AccountStorage): string[] {
  const value = read(storage, TRAINING_PROGRESS_KEY);
  if (!value || typeof value !== 'object' || !('completedLessonIds' in value) || !Array.isArray(value.completedLessonIds)) return [];
  return [...new Set(value.completedLessonIds.filter((id): id is string => typeof id === 'string' && lessonIds.includes(id)))];
}
export function rememberLesson(storage: AccountStorage, id: string): string[] {
  const completed = readCompletedLessons(storage);
  const next = lessonIds.includes(id) ? [...new Set([...completed, id])] : completed;
  try { storage.setItem(TRAINING_PROGRESS_KEY, JSON.stringify({ completedLessonIds: next })); } catch { /* Lesson remains complete in the current board. */ }
  return next;
}
