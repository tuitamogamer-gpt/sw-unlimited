import { createContext, useEffect, useRef, useState } from 'react';
import type { Card, GameView } from './types';

export type BattleFeedback = {
  added: ReadonlySet<string>;
  damaged: ReadonlySet<string>;
  baseChanges: Record<string, number>;
  message: string;
};
const empty: BattleFeedback = { added: new Set(), damaged: new Set(), baseChanges: {}, message: '' };
export const BattleFeedbackContext = createContext<BattleFeedback>(empty);
const board = (view: GameView) => Object.values(view.players).flatMap(player => [player.base, ...player.ground, ...player.space]);
const health = (card: Card) => card.remainingHp ?? (card.hp || 0) - (card.damage || 0);

/** Feedback compares only the already redacted, visible boards. */
export function useBattleFeedback(game: GameView): BattleFeedback {
  const previous = useRef<GameView | null>(null);
  const [feedback, setFeedback] = useState<BattleFeedback>(empty);
  useEffect(() => {
    const before = previous.current;
    previous.current = game;
    if (!before || before.id !== game.id || before.version > game.version) { setFeedback(empty); return; }
    if (before.version === game.version) return;
    const old = new Map(board(before).map(card => [card.uuid, card]));
    const added = new Set<string>(), damaged = new Set<string>();
    for (const card of board(game)) {
      const prior = old.get(card.uuid);
      if (!prior) added.add(card.uuid);
      else if ((card.damage || 0) > (prior.damage || 0) || health(card) < health(prior)) damaged.add(card.uuid);
    }
    const baseChanges = Object.fromEntries(Object.entries(game.players).map(([id, player]) => [id, health(player.base) - health(before.players[id as 'human' | 'bot'].base)]));
    const messages = game.log.slice(before.log.length).map(entry => typeof entry === 'string' ? entry : entry.text || entry.message || '');
    const recent = [...messages].reverse();
    const important = /\b(?:plays|attacks|uses|deploys|captures|defeats|heals)\b/i;
    const message = recent.find(entry => /^AI\b/.test(entry) && important.test(entry))
      || recent.find(entry => important.test(entry)) || recent.find(entry => /claims initiative|has won|Round:/.test(entry)) || '';
    setFeedback(current => ({ added, damaged, baseChanges, message: message || current.message }));
    const timer = setTimeout(() => setFeedback(current => ({ ...current, added: new Set(), damaged: new Set(), baseChanges: {} })), 2600);
    return () => clearTimeout(timer);
  }, [game.id, game.version]);
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
