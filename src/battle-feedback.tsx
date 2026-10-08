import { createContext, useEffect, useRef, useState } from 'react';
import type { GameView } from './types';
import { captureBattleSnapshot, diffBattleSnapshots, latestBattleMessage, mergeBattleEvents, summarizeBattleEvents } from './battle-feedback-events';
import type { BattleFeedback, BattleSnapshot } from './battle-feedback-events';
export type { BattleEvent, BattleFeedback } from './battle-feedback-events';

const empty: BattleFeedback = summarizeBattleEvents([]);
export const BattleFeedbackContext = createContext<BattleFeedback>(empty);

/** Feedback compares only the already redacted, visible boards. */
export function useBattleFeedback(game: GameView, { resetKey }: { resetKey?: unknown } = {}): BattleFeedback {
  const previous = useRef<{ snapshot: BattleSnapshot; resetKey: unknown } | null>(null);
  const [feedback, setFeedback] = useState<BattleFeedback>(empty);
  useEffect(() => {
    const prior = previous.current;
    const after = captureBattleSnapshot(game);
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
  }, [game.id, game.version, game.viewerId, resetKey]);
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
