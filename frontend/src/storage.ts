import type { PortfolioState } from "./types";

export const STORAGE_KEY = "myportfolio.local.v1";

export const blankState = (): PortfolioState => ({
  version: 1,
  profile: "",
  holdings: [],
  trades: [],
  pnl: null,
  capitalGains: null,
  quotes: {},
  imports: {},
  privacy: false,
});

export function loadState(): PortfolioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    const value = JSON.parse(raw) as PortfolioState;
    if (value?.version !== 1 || !Array.isArray(value.holdings) || !Array.isArray(value.trades)) {
      throw new Error("Unsupported local data");
    }
    return { ...blankState(), ...value };
  } catch {
    return blankState();
  }
}

export function saveState(state: PortfolioState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function downloadBackup(state: PortfolioState) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `my-portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function restoreBackup(file: File): Promise<PortfolioState> {
  if (file.size > 20 * 1024 * 1024) throw new Error("Backup must be smaller than 20 MB.");
  const value = JSON.parse(await file.text()) as PortfolioState;
  if (value?.version !== 1 || !Array.isArray(value.holdings) || !Array.isArray(value.trades)) {
    throw new Error("This is not a valid MyPortfolio backup.");
  }
  return { ...blankState(), ...value };
}
