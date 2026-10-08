export interface Card {
  uuid: string; id?: string; code?: string; name?: string; subtitle?: string; image?: string;
  cost?: number; power?: number; hp?: number; damage?: number; remainingHp?: number;
  pilotText?: string; upgradePower?: number | null; upgradeHp?: number | null;
  playCost?: number | null; playable?: boolean; playBlockedReason?: string | null;
  playOptions?: { title: string; cost: number; legal: boolean; reasonCode: string | null; reason: string | null }[];
  exhausted?: boolean; zone?: string; controllerId?: string; ownerId?: string;
  aspects?: string[]; keywords?: (string | { name: string; value?: number; cost?: number })[]; traits?: string[]; text?: string; type?: string; upgrades?: Card[];
  captured?: Card[]; selectable?: boolean; selected?: boolean; hidden?: boolean;
  unimplemented?: boolean; frontImage?: string; backImage?: string; deployed?: boolean; frontText?: string; deployText?: string; epicAction?: string;
}
export interface Deck {
  id: string; name: string; set: string; setName?: string; description?: string;
  leader: Card; base?: Card; cards?: { count: number; card: Card }[];
  custom?: boolean; sideboardCards?: { count: number; card: Card }[];
  aspects?: string[]; supported?: boolean; product?: string; count?: number; format?: string; baseHealth?: number; playstyle?: string;
  coverage?: { implemented?: number; total?: number; missing?: string[] };
}
export interface Player {
  id: string; name: string; base: Card; leader: Card; leaders: Card[]; hand: Card[];
  ground: Card[]; space: Card[]; resources: Card[]; discard: Card[]; deckCount: number;
  handCount: number; resourceCount: number; readyResources: number; hasInitiative: boolean; active: boolean;
  forceToken?: { active: boolean; uuid?: string; selectable?: boolean }; credits?: Card[]; outsideTheGame?: Card[];
}
export interface GameAction {
  type: 'card' | 'button' | 'perCard' | 'stateful'; version?: number; cardId?: string; promptId?: string; arg?: string;
  method?: string; label?: string; displayLabel?: string;
  intent?: 'resource' | 'play' | 'attack' | 'deploy' | 'ability' | 'select';
  abilities?: { title: string; type: string; cost?: number | null }[]; disabled?: boolean;
  result?: { type: string; valueDistribution: { uuid: string; amount: number }[] };
}
export interface PromptButton { text: string; arg: string; command?: string; disabled?: boolean }
export interface Prompt {
  id: string; title: string; subtitle?: string; type?: string; selectMode?: string; selectOrder?: boolean;
  stage?: 'resource' | 'action' | 'mulligan' | 'initiative' | 'target' | 'choice' | 'waiting' | 'finished';
  resourceSelection?: { min: number; max: number; selected: number; canSkip: boolean } | null;
  selectedCardIds: string[]; selectableCardIds: string[]; buttons: PromptButton[];
  displayCards: (Card & { cardUuid?: string; selectionState?: string; displayText?: string; selectionOrder?: number })[];
  number?: { min: number; max: number } | null; dropdown?: string[];
  distribution?: { type: string; amount: number; canDistributeLess?: boolean; canChooseNoTargets?: boolean; maxTargets?: number; isIndirectDamage?: boolean } | null;
  attackerId?: string; active: boolean;
}
export interface LogEntry { id?: string | number; message?: string; text?: string; round?: number; type?: string; player?: string }
export interface BotThinking { action?: string; reason?: string; score?: number; alternatives?: { label?: string; score?: number }[] }
export interface GameView {
  id: string; sessionToken?: string; version: number; phase: string; round: number; initiativePlayerId?: string; initiativeClaimed?: boolean;
  winnerIds: string[]; viewerId: string; players: { human: Player; bot: Player }; prompt: Prompt;
  legalActions: GameAction[]; log: (LogEntry | string)[]; botReason?: string; botThinking?: BotThinking;
  ai?: { reason?: string; lastDecision?: BotThinking; decisions?: BotThinking[] }; difficulty?: string;
  botHistory?: BotThinking[]; warnings?: string[];
}

export interface CustomDeckRecipe {
  custom: true;
  id: string;
  name: string;
  metadata: { name: string; [key: string]: unknown };
  leader: { id: string; count: number };
  base: { id: string; count: number };
  deck: { id: string; count: number }[];
  sideboard: { id: string; count: number }[];
}
export interface DeckValidationIssue {
  code: string;
  message: string;
  params?: Record<string, string | number>;
  severity: 'error' | 'warning';
}
export interface ImportedDeck extends Deck {
  custom: true;
  recipe: CustomDeckRecipe;
  validation: { valid: boolean; errors: string[]; warnings: string[] };
}
export interface SavedCustomDeck extends ImportedDeck { savedAt: number }
export interface DeckImportResponse {
  deck?: ImportedDeck;
  errors: string[];
  warnings: string[];
  issues?: DeckValidationIssue[];
}
