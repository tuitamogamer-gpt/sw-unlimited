import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameView, PublicPlayEvent, PublicDamageEvent } from './types';
import { newOpponentPlays, newBattlePresentations, DAMAGE_PRESENTATION_MS, OPPONENT_PREVIEW_MS, withUnrevealedPlaysHidden } from './opponent-presentation';

export function useOpponentPresentation() {
  const [preview, setPreview] = useState<PublicPlayEvent | null>(null);
  const [damagePreview, setDamagePreview] = useState<PublicDamageEvent[] | null>(null);
  const current = useRef<{ id: string; timer?: ReturnType<typeof setTimeout>; resolve: (shown: boolean) => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (current.current) {
        clearTimeout(current.current.timer);
        current.current.resolve(false);
        current.current = null;
      }
    };
  }, []);
  const onPreviewReady = useCallback((id: string) => {
    const item = current.current;
    if (!item || item.id !== id || item.timer) return;
    item.timer = setTimeout(() => {
      if (current.current !== item) return;
      current.current = null;
      item.resolve(true);
    }, OPPONENT_PREVIEW_MS);
  }, []);
  const present = async (before: GameView, after: GameView, restored: boolean, showFrame: (view: GameView, revealed: PublicPlayEvent) => void) => {
    const plays = newOpponentPlays(before, after, restored);
    const steps = newBattlePresentations(before, after, restored);
    const revealedIds = new Set<string>();
    let revealedPlays = 0;
    for (const step of steps) {
      if (!mounted.current) return false;
      const shown = await new Promise<boolean>(resolve => {
        if (step.kind === 'play') {
          current.current = { id: step.event.id, resolve };
          setDamagePreview(null);
          setPreview(step.event);
        } else {
          const item = { id: step.events[0].id, resolve, timer: undefined as ReturnType<typeof setTimeout> | undefined };
          current.current = item;
          setPreview(null);
          setDamagePreview(step.events);
          item.timer = setTimeout(() => {
            if (current.current !== item) return;
            current.current = null;
            resolve(true);
          }, DAMAGE_PRESENTATION_MS);
        }
      });
      if (!shown || !mounted.current) return false;
      if (step.kind === 'play') {
        revealedIds.add(step.event.card.uuid);
        revealedPlays++;
        showFrame(withUnrevealedPlaysHidden(after, plays.slice(revealedPlays), revealedIds, before), step.event);
      }
    }
    if (!mounted.current) return false;
    setPreview(null);
    setDamagePreview(null);
    return true;
  };
  return { preview, damagePreview, present, onPreviewReady };
}
