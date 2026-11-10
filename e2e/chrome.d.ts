// Only what the specs call inside the browser; the code runs there, not in Node.
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<any> };
  storage: { local: object };
  alarms: { get(name: string): Promise<{ periodInMinutes?: number } | undefined> };
};
