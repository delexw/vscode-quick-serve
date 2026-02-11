export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  startCommand: string;
  status: ServerStatus;
  group?: string;
}

export enum ServerStatus {
  Unknown = 'unknown',
  Up = 'up',
  Down = 'down',
}
