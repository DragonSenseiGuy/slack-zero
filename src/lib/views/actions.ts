'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import {
  BUILT_IN_VIEWS,
  parseViewFilters,
  viewFiltersSchema,
  viewLayoutSchema,
  viewSortSchema,
  type SavedView,
  type ViewFilters,
  type ViewLayout,
  type ViewSort,
} from '@/lib/views/filters';

/**
 * Server actions for saved views (plan.md, Phase 4).
 *
 * Views are persisted in `ViewDefinition`. The `filters` column is Json, so it
 * is untrusted on the way in *and* on the way out: `viewFiltersSchema` validates
 * writes, and `parseViewFilters` tolerates unreadable reads by degrading to "no
 * filters" rather than crashing the inbox.
 *
 * Server actions rather than client fetches, per CLAUDE.md.
 */

export type ViewMutationResult =
  | { ok: true; view: SavedView }
  | { ok: false; error: string };

export type ViewDeleteResult = { ok: true } | { ok: false; error: string };

const MAX_NAME_LENGTH = 60;

type ViewRow = {
  id: string;
  name: string;
  layout: string;
  filters: unknown;
  sort: string;
  isBuiltIn: boolean;
  position: number;
};

/** DB row → the serializable shape a client component can hold. */
function toSavedView(row: ViewRow): SavedView {
  const layout = viewLayoutSchema.safeParse(row.layout);
  const sort = viewSortSchema.safeParse(row.sort);

  return {
    id: row.id,
    name: row.name,
    // A row with an unknown layout/sort (older build, hand-edited) falls back to
    // a working default instead of rendering nothing.
    layout: layout.success ? layout.data : 'detailed',
    sort: sort.success ? sort.data : 'newest',
    filters: parseViewFilters(row.filters),
    isBuiltIn: row.isBuiltIn,
    position: row.position,
  };
}

const SELECT = {
  id: true,
  name: true,
  layout: true,
  filters: true,
  sort: true,
  isBuiltIn: true,
  position: true,
} as const;

/**
 * Every saved view, sidebar order.
 *
 * Seeds the built-ins on first call so a fresh database still shows "Needs
 * Reply" / "Waiting Room" / "Everything" without a separate setup step. The
 * seed is a `createMany` with `skipDuplicates`, keyed on the unique name, so
 * concurrent callers converge rather than racing — and a built-in the user has
 * since edited is never overwritten.
 */
export async function listViews(): Promise<SavedView[]> {
  const existing = await prisma.viewDefinition.findMany({
    select: SELECT,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });

  // Seed any built-in that is *missing*, not just on a wholly empty table.
  //
  // Seeding only when empty looks equivalent and is not: it means a built-in
  // added in a later phase never appears for anyone whose database already has
  // views. Phase 6 added "Waiting on Others" and it was invisible on every
  // existing install until this was fixed.
  //
  // Only absent names are created, so a built-in the user has since edited is
  // left exactly as they left it, and a built-in they deleted stays deleted for
  // the length of this call — `deleteView` refuses built-ins precisely because
  // this would otherwise resurrect them.
  const present = new Set(existing.map((view) => view.name));
  const missing = BUILT_IN_VIEWS.filter((view) => !present.has(view.name));

  if (missing.length === 0) return existing.map(toSavedView);

  await prisma.viewDefinition.createMany({
    data: missing.map((view) => ({
      name: view.name,
      layout: view.layout,
      sort: view.sort,
      filters: view.filters as object,
      isBuiltIn: true,
      position: view.position,
    })),
    skipDuplicates: true,
  });

  const seeded = await prisma.viewDefinition.findMany({
    select: SELECT,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });

  return seeded.map(toSavedView);
}

function validate(input: {
  name: string;
  layout: ViewLayout;
  sort: ViewSort;
  filters: ViewFilters;
}): string | null {
  const name = input.name.trim();
  if (name === '') return 'A view needs a name.';
  if (name.length > MAX_NAME_LENGTH) {
    return `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  }
  if (!viewLayoutSchema.safeParse(input.layout).success) {
    return 'Unknown layout.';
  }
  if (!viewSortSchema.safeParse(input.sort).success) {
    return 'Unknown sort order.';
  }
  if (!viewFiltersSchema.safeParse(input.filters).success) {
    return 'Those filters are not valid.';
  }
  return null;
}

/** Postgres unique-violation, i.e. the name is taken. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export async function createView(input: {
  name: string;
  layout: ViewLayout;
  sort: ViewSort;
  filters: ViewFilters;
}): Promise<ViewMutationResult> {
  const invalid = validate(input);
  if (invalid) return { ok: false, error: invalid };

  try {
    const last = await prisma.viewDefinition.findFirst({
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const row = await prisma.viewDefinition.create({
      data: {
        name: input.name.trim(),
        layout: input.layout,
        sort: input.sort,
        filters: input.filters as object,
        isBuiltIn: false,
        position: (last?.position ?? -1) + 1,
      },
      select: SELECT,
    });

    revalidatePath('/inbox');
    return { ok: true, view: toSavedView(row) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, error: `A view called "${input.name.trim()}" already exists.` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not save the view: ${detail}` };
  }
}

export async function updateView(
  id: string,
  input: {
    name: string;
    layout: ViewLayout;
    sort: ViewSort;
    filters: ViewFilters;
  },
): Promise<ViewMutationResult> {
  if (!id) return { ok: false, error: 'A view id is required.' };

  const invalid = validate(input);
  if (invalid) return { ok: false, error: invalid };

  try {
    const row = await prisma.viewDefinition.update({
      where: { id },
      data: {
        name: input.name.trim(),
        layout: input.layout,
        sort: input.sort,
        filters: input.filters as object,
      },
      select: SELECT,
    });

    revalidatePath('/inbox');
    return { ok: true, view: toSavedView(row) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, error: `A view called "${input.name.trim()}" already exists.` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not update the view: ${detail}` };
  }
}

/**
 * Delete a view.
 *
 * Built-ins are refused rather than silently ignored: they would reappear on the
 * next empty-table seed, so "deleting" one would look like it worked and then
 * undo itself.
 */
export async function deleteView(id: string): Promise<ViewDeleteResult> {
  if (!id) return { ok: false, error: 'A view id is required.' };

  try {
    const existing = await prisma.viewDefinition.findUnique({
      where: { id },
      select: { isBuiltIn: true, name: true },
    });

    if (!existing) return { ok: false, error: 'That view no longer exists.' };
    if (existing.isBuiltIn) {
      return {
        ok: false,
        error: `"${existing.name}" is a built-in view and cannot be deleted.`,
      };
    }

    await prisma.viewDefinition.delete({ where: { id } });
    revalidatePath('/inbox');
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not delete the view: ${detail}` };
  }
}

/** Mark a person VIP, which the VIP filter and sort both read. */
export async function setUserVip(
  userId: string,
  isVip: boolean,
): Promise<{ ok: true; userId: string; isVip: boolean } | { ok: false; error: string }> {
  if (!userId) return { ok: false, error: 'A user id is required.' };

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isVip },
      select: { id: true, isVip: true },
    });

    revalidatePath('/inbox');
    return { ok: true, userId: user.id, isVip: user.isVip };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not update VIP status: ${detail}` };
  }
}
