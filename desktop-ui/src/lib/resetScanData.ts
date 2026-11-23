// The words of Settings, Data, Reset scan data: what the sheet says is deleted and kept, and where the backup goes.
// One place, so the sheet and its test read the same thing (the agent's /api/data/reset does exactly this).

export const RESET_DELETES: readonly string[] = [
  'The deals, the Review questions and the AI suggestions',
  'Every scan, the bundles and parts it read, and their Amazon matches and prices',
  'Activity (runs and errors), Autopilot history and your saved answers',
  'Watched deals and price tracking, and queued Chrome jobs',
];

export const RESET_KEEPS: readonly string[] = [
  'Your keys',
  'Your settings',
  'The pairing with Chrome',
  'Saved search responses, so a new scan does not pay for them again',
];

/** Where the backup goes, in a sentence; `dataDir` is the app's data folder when the shell knows it. */
export function backupLine(dataDir: string | null | undefined): string {
  const where = dataDir ? `in ${dataDir}` : 'in the data folder';
  return `Before anything is deleted, a copy goes to a new folder named backup-before-reset and the time, ${where}. It is kept until you delete it, and it holds no keys.`;
}

export const RESET_BUTTON = 'Reset scan data';
