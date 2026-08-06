import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readSpmtAccessToken, requireSpmtIdentity } from "./spmtAuth.js";

type LocalSettings = {
  useSharedUi: boolean;
  localAppearance: {
    glassOpacity: number;
    blurStrength: number;
    glowIntensity: number;
    cornerRadius: number;
    smooth