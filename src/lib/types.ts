// Types shared by the server routes and the browser UI.

export type ResourceKind = "lesson" | "review" | "cards" | "quiz";
export type QuizDifficulty = "mixed" | "easier" | "harder";
/** Questions about the material, new practice problems, or a mix. */
export type QuizStyle = "mixed" | "material" | "practice";

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  topic: string;
  difficulty: "recall" | "understanding" | "application";
  /** "problem" = a new practice problem the model made up; "concept" = tests the material itself. */
  kind?: "concept" | "problem";
  /** A fenced ```graph or ```svg block shown above the question. */
  figure?: string;
}

export interface Flashcard {
  front: string;
  back: string;
  topic: string;
}

/** One finished run of a quiz, kept so progress can be shown over time. */
export interface QuizAttempt {
  at: number;
  mode: "practice" | "test";
  correct: number;
  total: number;
  points: number;
  /** topic → [correct, asked] */
  topics: Record<string, [number, number]>;
}

export interface Quiz {
  title: string;
  questions: QuizQuestion[];
}

export interface MaterialSummary {
  name: string;
  source: "upload" | "paste" | "canvas";
  /** How the material reached the model. */
  as: "pdf" | "image" | "text";
  detail?: string;
}

/** Newline-delimited JSON events streamed from POST /api/generate. */
export type GenerateEvent =
  | { type: "materials"; items: MaterialSummary[]; warnings: string[]; personalized: boolean }
  | { type: "start"; resource: ResourceKind }
  | { type: "delta"; resource: "lesson" | "review"; text: string }
  | { type: "progress"; resource: "quiz" | "cards"; count: number; checking?: boolean }
  | { type: "done"; resource: ResourceKind; quiz?: Quiz; cards?: Flashcard[]; note?: string; truncated?: boolean; text?: string }
  | { type: "error"; resource?: ResourceKind; message: string }
  | { type: "end" };

export interface GenerateOptions {
  resources: ResourceKind[];
  quizLength: number;
  gradeLevel: string;
  focus: string;
  difficulty?: QuizDifficulty;
  quizStyle?: QuizStyle;
  /** Topics the student keeps missing; a new quiz leans toward these. */
  focusTopics?: string[];
  /** Questions from earlier quizzes on this material; a new quiz must not repeat them. */
  avoid?: string[];
  canvas?: {
    courseId: string;
    refs: string[];
    personalize: boolean;
  };
}

// ---- Canvas -------------------------------------------------------------

export interface SessionInfo {
  locked: boolean;
  oauthAvailable: boolean;
  oauthHost?: string;
  canvas: null | { host: string; userName: string; via: "token" | "oauth" };
}

export interface CanvasCourse {
  id: string;
  name: string;
  code?: string;
  term?: string;
  currentScore?: number | null;
}

export interface CanvasMaterial {
  /** Opaque reference sent back to the server: page:<slug>, file:<id>, assignment:<id>, syllabus */
  ref: string;
  kind: "page" | "file" | "assignment" | "syllabus" | "other";
  title: string;
  importable: boolean;
  note?: string;
}

export interface CanvasAssignment {
  id: string;
  name: string;
  dueAt: string | null;
  pointsPossible: number | null;
  score: number | null;
  submitted: boolean;
  missing: boolean;
  isQuiz: boolean;
}

export interface CanvasCourseOverview {
  course: CanvasCourse;
  hasSyllabus: boolean;
  modules: { id: string; name: string; items: CanvasMaterial[] }[];
  pages: CanvasMaterial[];
  files: CanvasMaterial[];
  assignments: CanvasAssignment[];
  /** Sections Canvas would not let this student list (e.g. Files hidden). */
  unavailable: string[];
}

// ---- Saved study sets (browser storage) ----------------------------------

export interface StudySet {
  id: string;
  title: string;
  createdAt: number;
  sources: string[];
  lesson: string;
  review: string;
  quiz: Quiz | null;
  cards?: Flashcard[] | null;
  /** Fronts of the flashcards the student marked as known. */
  known?: string[];
  attempts?: QuizAttempt[];
  bestScore?: { correct: number; total: number; points: number };
  /** Free-form notes the student writes for this set. */
  notes?: string;
  /** The class this set belongs to (a Canvas course name, or typed). */
  course?: string;
  /** Every question already asked in earlier quizzes of this set. */
  pastQuestions?: string[];
}
