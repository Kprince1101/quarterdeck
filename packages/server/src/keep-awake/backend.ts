export interface HoldSpec {
  seconds: number | null;
  ownerPid: number;
}

export interface HoldCommand {
  command: string;
  args: string[];
}

export interface KeepAwakeBackend {
  platform: NodeJS.Platform;
  tool: string;
  command: (hold: HoldSpec) => HoldCommand;
}
