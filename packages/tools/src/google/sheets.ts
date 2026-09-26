import {
  type GoogleCredentials,
  type GoogleDeps,
  SCOPES,
  googleAccessToken,
  googleError,
  googleJson,
} from "./auth";
import { ToolError } from "../errors";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export type SheetRef = { credentials: GoogleCredentials; spreadsheetId: string; sheetName: string };

/** A1 range for a sheet name ('My sheet'!A1), quotes escaped */
const range = (sheet: string) => `'${sheet.replace(/'/g, "''")}'!A1`;

/**
 * Append one row. RAW input: values are stored as text exactly as given, so caller-supplied
 * answers can never become spreadsheet formulas.
 */
export async function appendRow(
  ref: SheetRef,
  values: (string | number | boolean)[],
  deps: GoogleDeps,
): Promise<{ updatedRange: string }> {
  const token = await googleAccessToken(ref.credentials, SCOPES.sheets, deps);
  const q = new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
  const url = `${API}/${encodeURIComponent(ref.spreadsheetId)}/values/${encodeURIComponent(range(ref.sheetName))}:append?${q}`;
  const { status, data } = await googleJson<{ updates?: { updatedRange?: string } }>(deps, token, url, {
    method: "POST",
    body: {
      majorDimension: "ROWS",
      values: [values.map((v) => (typeof v === "string" ? v.slice(0, 5000) : v))],
    },
  });
  if (status !== 200) throw googleError(status, data, "Adding the row failed");
  return { updatedRange: data.updates?.updatedRange ?? "" };
}

/** Can we open the spreadsheet and does the tab exist? (connection test) */
export async function checkSheet(ref: SheetRef, deps: GoogleDeps): Promise<{ title: string }> {
  const token = await googleAccessToken(ref.credentials, SCOPES.sheets, deps);
  const { status, data } = await googleJson<{
    properties?: { title?: string };
    sheets?: { properties?: { title?: string } }[];
  }>(
    deps,
    token,
    `${API}/${encodeURIComponent(ref.spreadsheetId)}?fields=properties.title,sheets.properties.title`,
  );
  if (status !== 200) throw googleError(status, data, "Opening the spreadsheet failed");
  if (!data.sheets?.some((s) => s.properties?.title === ref.sheetName))
    throw new ToolError("config", `The spreadsheet has no tab named "${ref.sheetName}"`);
  return { title: data.properties?.title ?? ref.spreadsheetId };
}
