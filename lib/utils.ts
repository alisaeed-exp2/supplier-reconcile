import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "n/a" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
