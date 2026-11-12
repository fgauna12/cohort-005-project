import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export const saveNoteSchema = z.object({
  body: z.string().trim().max(2000, "Note must be 2,000 characters or fewer."),
});

export function getBookmark(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

export function toggleBookmark(db: Db, userId: number, lessonId: number) {
  return db.transaction((tx) => {
    const existing = getBookmark(tx, userId, lessonId);
    if (existing) {
      tx.delete(bookmarks).where(eq(bookmarks.id, existing.id)).run();
      return false;
    }
    tx.insert(bookmarks).values({ userId, lessonId }).run();
    return true;
  });
}

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
) {
  const parsed = saveNoteSchema.safeParse({ body });
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message };
  }
  if (!parsed.data.body) {
    db.delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true as const };
  }

  const timestamp = now.toISOString();
  db.insert(notes)
    .values({
      userId,
      lessonId,
      body: parsed.data.body,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data.body, updatedAt: timestamp },
    })
    .run();
  return { ok: true as const };
}

const lessonRef = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseId: courses.id,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

export function getSavedItems(db: Db, userId: number) {
  const savedBookmarks = db
    .select({ id: bookmarks.id, createdAt: bookmarks.createdAt, ...lessonRef })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();

  const savedNotes = db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonRef,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();

  return { savedBookmarks, savedNotes };
}
