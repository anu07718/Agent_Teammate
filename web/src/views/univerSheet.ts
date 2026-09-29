/** Loaded on demand: the Univer spreadsheet engine is large, so only the Ledger view pulls it in. */
import { LocaleType, createUniver, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";

export interface SheetSpec { id: string; name: string; header: string[]; rows: (string | number | null)[][]; widths?: number[] }

export function mountWorkbook(container: HTMLElement, sheets: SheetSpec[], dark: boolean) {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsEnUS) },
    darkMode: dark,
    presets: [UniverSheetsCorePreset({ container, header: false, toolbar: false, footer: false, formulaBar: true })],
  });
  const data: Record<string, any> = {};
  for (const s of sheets) {
    const cellData: Record<number, Record<number, { v: string | number; s?: any }>> = {};
    cellData[0] = Object.fromEntries(s.header.map((h, c) => [c, { v: h, s: { bl: 1, bg: { rgb: "#e2e8f0" } } }]));
    s.rows.forEach((r, i) => {
      cellData[i + 1] = Object.fromEntries(r.map((v, c) => [c, { v: v ?? "" }]));
    });
    data[s.id] = {
      id: s.id, name: s.name, rowCount: Math.max(40, s.rows.length + 5), columnCount: Math.max(10, s.header.length + 1),
      cellData, freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
      columnData: Object.fromEntries((s.widths ?? s.header.map(() => 120)).map((w, i) => [i, { w }])),
    };
  }
  (univerAPI as any).createWorkbook({ id: "nirnaya-ledger", name: "Ledger", sheetOrder: sheets.map((s) => s.id), sheets: data });
  return () => univer.dispose();
}
