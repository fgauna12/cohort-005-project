import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getBookmark,
  getNote,
  getSavedItems,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

const NOW = new Date("2026-10-06T12:00:00Z");
const LATER = new Date("2026-10-06T13:00:00Z");
let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  [lessonId, otherLessonId] = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({
          moduleId: module.id,
          title: `Lesson ${position}`,
          position,
        })
        .returning()
        .get().id
  );
});

describe("Bookmarks and Notes", () => {
  it("toggles one Bookmark on and off without affecting another Student", () => {
    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(true);
    toggleBookmark(db, base.instructor.id, lessonId);
    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();
    expect(getSavedItems(db, base.user.id).savedBookmarks).toHaveLength(1);

    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(false);
    expect(getBookmark(db, base.user.id, lessonId)).toBeUndefined();
    expect(getBookmark(db, base.instructor.id, lessonId)).toBeDefined();
  });

  it("replaces a trimmed plain-text Note, preserving creation and moving last edited", () => {
    saveNote(db, base.user.id, lessonId, "  # Heading\n*not markdown*  ", NOW);
    expect(getNote(db, base.user.id, lessonId)).toMatchObject({
      body: "# Heading\n*not markdown*",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    saveNote(db, base.user.id, lessonId, "  Revised\nthoughts  ", LATER);
    expect(getNote(db, base.user.id, lessonId)).toMatchObject({
      body: "Revised\nthoughts",
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
    expect(getSavedItems(db, base.user.id).savedNotes).toHaveLength(1);
  });

  it("accepts exactly 2,000 characters and refuses longer Notes without overwriting", () => {
    expect(
      saveNote(db, base.user.id, lessonId, ` ${"a".repeat(2000)} `, NOW)
    ).toEqual({ ok: true });
    expect(
      saveNote(db, base.user.id, lessonId, "b".repeat(2001), LATER)
    ).toEqual({
      ok: false,
      error: "Note must be 2,000 characters or fewer.",
    });
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("a".repeat(2000));
  });

  it("clears only the owning Student's Note when saved empty", () => {
    saveNote(db, base.user.id, lessonId, "Mine", NOW);
    saveNote(db, base.instructor.id, lessonId, "Someone else's", NOW);
    saveNote(db, base.user.id, lessonId, " \n ", LATER);

    expect(getNote(db, base.user.id, lessonId)).toBeUndefined();
    expect(getNote(db, base.instructor.id, lessonId)?.body).toBe(
      "Someone else's"
    );
  });

  it("lists only the Student's rows, newest first, with Lesson and Course references", () => {
    toggleBookmark(db, base.user.id, lessonId);
    toggleBookmark(db, base.user.id, otherLessonId);
    db.update(schema.bookmarks)
      .set({ createdAt: NOW.toISOString() })
      .where(eq(schema.bookmarks.lessonId, otherLessonId))
      .run();
    db.update(schema.bookmarks)
      .set({ createdAt: LATER.toISOString() })
      .where(eq(schema.bookmarks.lessonId, lessonId))
      .run();
    saveNote(db, base.user.id, lessonId, "First", NOW);
    saveNote(db, base.user.id, otherLessonId, "Second", LATER);
    toggleBookmark(db, base.instructor.id, lessonId);
    saveNote(db, base.instructor.id, lessonId, "Private", LATER);

    const saved = getSavedItems(db, base.user.id);
    expect(saved.savedBookmarks.map((row) => row.lessonId)).toEqual([
      lessonId,
      otherLessonId,
    ]);
    expect(saved.savedNotes.map((row) => row.body)).toEqual([
      "Second",
      "First",
    ]);
    for (const row of [...saved.savedBookmarks, ...saved.savedNotes]) {
      expect(row).toMatchObject({
        lessonTitle: expect.stringMatching(/^Lesson [12]$/),
        courseTitle: base.course.title,
        courseSlug: base.course.slug,
      });
    }

    saveNote(
      db,
      base.user.id,
      lessonId,
      "Edited first",
      new Date(LATER.getTime() + 1000)
    );
    expect(
      getSavedItems(db, base.user.id).savedNotes.map((row) => row.body)
    ).toEqual(["Edited first", "Second"]);
  });

  it("enforces the one-per-Student-per-Lesson rule in the database", () => {
    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "Mine", NOW);
    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId })
        .run()
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: base.user.id, lessonId, body: "Duplicate" })
        .run()
    ).toThrow(/UNIQUE/);
  });

  it("keeps Bookmarks and Notes after an approved Refund", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({
        name: "Admin",
        email: "admin@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
      })
      .run();
    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "Keep my thoughts", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not for me.",
      LATER,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      LATER,
      notifications
    );
    expect(approved.ok).toBe(true);
    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("Keep my thoughts");
  });
});
