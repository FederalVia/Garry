import type Database from "better-sqlite3";
import type { ChatMessage } from "../types.js";
import {
  getActiveGoals,
  getTasksByGoal,
  type GoalRow,
  type TaskGraphRow,
} from "../state/database.js";

export const MAX_TODO_TOKENS = 2000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function assignee(assignedTo: string | null): string {
  return assignedTo ?? "unassigned";
}

function formatTaskLine(task: TaskGraphRow): string {
  if (task.status === "completed") {
    return `- [x] ${task.title} (completed by ${assignee(task.assignedTo)})`;
  }

  if (task.status === "running") {
    return `- [~] ${task.title} (running — ${assignee(task.assignedTo)})`;
  }

  if (task.status === "failed") {
    return `- [!] ${task.title} (failed)`;
  }

  const status = task.status === "blocked" ? "blocked" : "pending";
  return `- [ ] ${task.title} (${status})`;
}

function goalHeading(goal: GoalRow, tasks: TaskGraphRow[]): string {
  const estimatedBudgetCents = tasks.reduce((sum, task) => sum + task.estimatedCostCents, 0);
  const actualSpentCents = tasks.reduce((sum, task) => sum + task.actualCostCents, 0);
  const budget = `${formatDollars(estimatedBudgetCents)} budget, ${formatDollars(actualSpentCents)} spent`;
  return `## Goal: ${goal.title} [${budget}]`;
}

/** Superseded (cancelled) tasks are history, not work: they are left out. */
function visibleTasks(tasks: TaskGraphRow[]): TaskGraphRow[] {
  return tasks.filter((task) => task.status !== "cancelled");
}

function formatGoalSection(goal: GoalRow, tasks: TaskGraphRow[]): string {
  const lines = visibleTasks(tasks).map(formatTaskLine);
  return [goalHeading(goal, tasks), ...lines].join("\n");
}

/**
 * One goal over the budget: drop completed task lines first, then cut the
 * rest and say how many were left out.
 */
function fitGoalSection(header: string, goal: GoalRow, tasks: TaskGraphRow[]): string {
  const heading = goalHeading(goal, tasks);
  const visible = visibleTasks(tasks);
  const open = visible.filter((task) => task.status !== "completed");
  const completedCount = visible.length - open.length;
  const fits = (section: string) => estimateTokens(`${header}\n\n${section}`) <= MAX_TODO_TOKENS;

  const withCompletedNote = (lines: string[]) =>
    completedCount > 0 ? [...lines, `- (${completedCount} completed task(s) not shown)`] : lines;

  const openLines = open.map(formatTaskLine);
  let section = [heading, ...withCompletedNote(openLines)].join("\n");
  if (fits(section)) return section;

  let kept = openLines.length;
  while (kept > 0) {
    kept--;
    const omitted = openLines.length - kept;
    section = [heading, ...withCompletedNote([...openLines.slice(0, kept), `- … ${omitted} more tasks`])].join("\n");
    if (fits(section)) return section;
  }
  // Even the heading is too long: cut it.
  const budgetChars = MAX_TODO_TOKENS * CHARS_PER_TOKEN_ESTIMATE - header.length - 2;
  return section.slice(0, Math.max(0, budgetChars - 1)) + "…";
}

export function generateTodoMd(db: Database.Database): string {
  const activeGoals = getActiveGoals(db);
  if (activeGoals.length === 0) {
    return "";
  }

  const header = "# Active Goals";
  const goalTasks = activeGoals.map((goal) => ({ goal, tasks: getTasksByGoal(db, goal.id) }));
  const sections = goalTasks.map(({ goal, tasks }) => formatGoalSection(goal, tasks));

  let keptSections = sections;
  let todoMd = `${header}\n\n${keptSections.join("\n\n")}`;

  // Remove oldest goals first, preserving the most recent goal(s).
  while (estimateTokens(todoMd) > MAX_TODO_TOKENS && keptSections.length > 1) {
    keptSections = keptSections.slice(1);
    todoMd = `${header}\n\n${keptSections.join("\n\n")}`;
  }

  if (estimateTokens(todoMd) > MAX_TODO_TOKENS) {
    const last = goalTasks[goalTasks.length - 1];
    todoMd = `${header}\n\n${fitGoalSection(header, last.goal, last.tasks)}`;
  }

  return todoMd;
}

export function injectTodoContext(messages: ChatMessage[], todoMd: string): ChatMessage[] {
  if (todoMd.trim().length === 0) {
    return messages;
  }

  const todoMessage: ChatMessage = {
    role: "system",
    content: `## Current Goals & Tasks\n\n${todoMd}`,
  };

  return [...messages, todoMessage];
}
