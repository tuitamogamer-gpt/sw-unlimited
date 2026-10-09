import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameView, PublicPlayEvent } from './types';
import { newOpponentPlays, OPPONENT_PREVIEW_MS, withUnrevealedPlaysHidden } from './opponent-presentation';

export function useOpponentPresentation() {
  const [preview, setPreview] = useState<PublicPlayEvent | null>(null);
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
    const revealedIds = new Set<string>();
    for (let index = 0; index < plays.length; index++) {
      if (!mounted.current) return false;
      const shown = await new Promise<boolean>(resolve => {
        current.current = { id: plays[index].id, resolve };
        setPreview(plays[index]);
      });
      if (!shown || !mounted.current) return false;
      revealedIds.add(plays[index].card.uuid);
      showFrame(withUnrevealedPlaysHidden(after, plays.slice(index + 1), revealedIds, before), plays[index]);
    }
    if (!mounted.current) return false;
    setPreview(null);
    return true;
  };
  return { preview, present, onPreviewReady };
}
