import {
  KEEP_AWAKE_MINUTES,
  type KeepAwakeRequest,
} from '@quarterdeck/server/intents';
import type { KeepAwakeState } from '@quarterdeck/server/stream-schema';

export const KEEP_AWAKE_EXPLANATION =
  'Keeps your computer from sleeping so agents keep working. Your screen can still turn off and lock. On a laptop, closing the lid on battery still sleeps.';

export const KEEP_AWAKE_WAITING =
  'Waiting for the server to say whether it can keep this computer awake.';

export const KEEP_AWAKE_OFF_LABEL = 'Keep awake';

export const KEEP_AWAKE_UNTIL_VOYAGE_LABEL = 'Awake until voyage ends';

export const UNTIL_VOYAGE_ENDS = 'voyage';

export const DEFAULT_KEEP_AWAKE_CHOICE = '60';

export interface KeepAwakeChoice {
  value: string;
  label: string;
}

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

const minutesLabel = (minutes: number): string => {
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  return `${minutes / MINUTES_PER_HOUR}h`;
};

export const KEEP_AWAKE_CHOICES: readonly KeepAwakeChoice[] = [
  ...KEEP_AWAKE_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: minutesLabel(minutes),
  })),
  { value: UNTIL_VOYAGE_ENDS, label: 'Until voyage ends' },
];

export const keepAwakeRequest = (choice: string): KeepAwakeRequest => {
  if (choice === UNTIL_VOYAGE_ENDS) return { untilVoyageEnds: true };
  return { minutes: Number(choice) };
};

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const formatTimeLeft = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / MS_PER_SECOND));
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = total % SECONDS_PER_MINUTE;
  if (hours > 0) return `${hours}h ${twoDigits(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${twoDigits(seconds)}s`;
  return `${seconds}s`;
};

export interface KeepAwakeView {
  isOn: boolean;
  isDisabled: boolean;
  buttonLabel: string;
  title: string;
  note: string;
}

const onLabel = (state: KeepAwakeState, now: number): string => {
  if (state.expiresAt === null) return KEEP_AWAKE_UNTIL_VOYAGE_LABEL;
  return `Awake: ${formatTimeLeft(Date.parse(state.expiresAt) - now)} left`;
};

const unavailable = (reason: string): KeepAwakeView => ({
  isOn: false,
  isDisabled: true,
  buttonLabel: KEEP_AWAKE_OFF_LABEL,
  title: `${reason} ${KEEP_AWAKE_EXPLANATION}`,
  note: reason,
});

export const keepAwakeView = (
  state: KeepAwakeState | null,
  now: number,
): KeepAwakeView => {
  if (state === null) return unavailable(KEEP_AWAKE_WAITING);
  if (!state.available) {
    return unavailable(state.unavailableReason ?? KEEP_AWAKE_WAITING);
  }
  if (!state.on) {
    return {
      isOn: false,
      isDisabled: false,
      buttonLabel: KEEP_AWAKE_OFF_LABEL,
      title: KEEP_AWAKE_EXPLANATION,
      note: KEEP_AWAKE_EXPLANATION,
    };
  }
  return {
    isOn: true,
    isDisabled: false,
    buttonLabel: onLabel(state, now),
    title: `${KEEP_AWAKE_EXPLANATION} Click to stop.`,
    note: KEEP_AWAKE_EXPLANATION,
  };
};
