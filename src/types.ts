export interface SizeValue {
  w: string;
  d: string;
  h: string;
}

export interface FormStage {
  date: string;
  clay: string;
  size: SizeValue;
  innerSize: SizeValue;
  photos: string[];
}

export interface BisqueStage {
  date: string;
  size: SizeValue;
  innerSize: SizeValue;
}

export interface DecorationStage {
  date: string;
  techniques: string[];
  glazes: string[];
  method: string;
  photos: string[];
}

export interface FinalStage {
  date: string;
  size: SizeValue;
  innerSize: SizeValue;
  kilnTemp: string;
  photos: string[];
}

export interface Piece {
  id: string;
  name: string;
  createdAt: string;
  form: FormStage;
  bisque: BisqueStage;
  decoration: DecorationStage;
  final: FinalStage;
  comment: string;
}

export interface Idea {
  id: string;
  createdAt: string;
  images: string[];
  url: string;
  memo: string;
}

export type StageKey = 'form' | 'bisque' | 'decoration' | 'final';
export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

// Bump this whenever the shape of Piece/Idea changes in a way that old
// backup files wouldn't already tolerate via normalizePiece/normalizeIdea.
export const SCHEMA_VERSION = 1;

export interface BackupPayload {
  schemaVersion: number;
  exportedAt: string;
  pieces: Piece[];
  ideas: Idea[];
  customTechniques: string[];
}
