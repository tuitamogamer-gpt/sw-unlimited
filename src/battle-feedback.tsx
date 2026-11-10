import { createContext, useEffect, useRef, useState } from 'react';
import type { GameView } from './types';
import { captureBattleSnapshot, defeatedUnits, diffBattleSnapshots, latestBattleMessage, mergeBattleEvents, summarizeBattleEvents } from './battle-feedback-events';
import type { BattleFeedback, BattleSnapshot, DefeatedUnit } from './battle-feedback-events';
import type { Duel } from './battle-duel';
export type { BattleEvent, BattleFeedback } from './battle-feedback-events';

const empty: BattleFeedback = summarizeBattleEvents([]);
export const BattleFeedbackContext = createContext<BattleFeedback>(empty);
/** The exchange currently shown above the table, if any. */
export const DuelContext = createContext<Duel | null>(null);

export const DEFEAT_GHOST_MS = 760;
export type DefeatGhost = DefeatedUnit & { expiresAt: number };

/** Keeps a defeated unit's last public face for a moment after the table
 * updates, so it can be shown leaving its lane. State is derived while
 * rendering: the lane never paints one frame without the unit and the next
 * with it. A new game, a resume or a rewind starts clean. */
export function useDefeatGhosts(game: GameView, resetKey?: unknown): readonly DefeatGhost[] {
  const [state, setState] = useState<{ game: GameView; resetKey: unknown; ghosts: DefeatGhost[] }>(() => ({ game, resetKey, ghosts: [] }));
  let current = state;
  if (state.game !== game || state.resetKey !== resetKey) {
    const continuous = state.resetKey === resetKey && state.game.id === game.id;
    const now = Date.now();
    const kept = continuous ? state.ghosts.filter(ghost => ghost.expiresAt > now) : [];
    const fresh = continuous ? defeatedUnits(state.game, game).filter(unit => !kept.some(ghost => ghost.card.uuid === unit.card.uuid)) : [];
    current = { game, resetKey, ghosts: [...kept, ...fresh.map(unit => ({ ...unit, expiresAt: now + DEFEAT_GHOST_MS }))] };
    setState(current);
  }
  const ghosts = current.ghosts;
  useEffect(() => {
    if (!ghosts.length) return;
    const expiresAt = Math.min(...ghosts.map(ghost => ghost.expiresAt));
    const timer = setTimeout(() => setState(old => ({ ...old, ghosts: old.ghosts.filter(ghost => ghost.expiresAt > Date.now()) })), Math.max(0, expiresAt - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [ghosts]);
  return ghosts;
}

/** Counts increases after the first render. A token keyed by this number
 * restarts its own short animation when its value grows, and stays still on
 * load, on resume and when an arena tab is switched. */
export function useRise(value: number): number {
  const previous = useRef(value);
  const [rises, setRises] = useState(0);
  useEffect(() => {
    if (value > previous.current) setRises(count => count + 1);
    previous.current = value;
  }, [value]);
  return rises;
}

/** Feedback compares only the already redacted, visible boards. */
export function useBattleFeedback(game: GameView, { resetKey, presentationRevision }: { resetKey?: unknown; presentationRevision?: number } = {}): BattleFeedback {
  const previous = useRef<{ snapshot: BattleSnapshot; resetKey: unknown } | null>(null);
  const [feedback, setFeedback] = useState<BattleFeedback>(empty);
  useEffect(() => {
    const prior = previous.current;
    const after = captureBattleSnapshot(game);
    // A response may reveal several opponent plays one at a time. Keep visual
    // frames independent of the authoritative version used to submit actions.
    if (presentationRevision !== undefined) after.version = presentationRevision;
    previous.current = { snapshot: after, resetKey };
    if (!prior || prior.resetKey !== resetKey || prior.snapshot.id !== after.id
      || prior.snapshot.viewerId !== after.viewerId || prior.snapshot.version > after.version) {
      setFeedback(empty); return;
    }
    if (prior.snapshot.version === after.version) return;
    const now = Date.now();
    const events = diffBattleSnapshots(prior.snapshot, after, now);
    const message = latestBattleMessage(prior.snapshot, after);
    setFeedback(current => summarizeBattleEvents(mergeBattleEvents(current.events, events, now), message || current.message));
  }, [game.id, game.version, game.viewerId, resetKey, presentationRevision]);
  // One timer for the earliest individual expiry. A later response reschedules
  // the remaining duration; it never extends or clears unrelated events.
  useEffect(() => {
    if (!feedback.events.length) return;
    const expiresAt = Math.min(...feedback.events.map(event => event.expiresAt));
    const timer = setTimeout(() => setFeedback(current => summarizeBattleEvents(
      mergeBattleEvents(current.events, [], Date.now()), current.message,
    )), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [feedback.events]);
  return feedback;
}

export function useOverflowCues() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const left = node.scrollLeft > 3, right = node.scrollWidth - node.clientWidth - node.scrollLeft > 3;
      setEdges(old => old.left === left && old.right === right ? old : { left, right });
    };
    const resize = new ResizeObserver(update);
    resize.observe(node);
    for (const child of node.children) resize.observe(child);
    node.addEventListener('scroll', update, { passive: true });
    update();
    return () => { resize.disconnect(); node.removeEventListener('scroll', update); };
  });
  return { ref, overflowing: edges.left || edges.right, className: `${edges.left ? 'can-scroll-left' : ''} ${edges.right ? 'can-scroll-right' : ''}` };
}
