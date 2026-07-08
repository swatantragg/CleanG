import Icon from "./Icon.jsx";

// How many numbered buttons we render before switching to a windowed list with
// ellipses. Below this every page gets its own button.
const FULL_LIST_MAX = 7;

// Rows-per-page choices offered everywhere. 0 means "All" — the caller turns it
// into a page size big enough to hold every matching row.
export const PAGE_SIZE_OPTIONS = [50, 100, 150, 200, 0];

// A page size of 0 ("All") has no natural number, so callers ask for this many
// rows instead: far beyond any real dataset, and the server just slices.
export const ALL_ROWS = 1_000_000;

// Turn the selected option into the page size to send to the API.
export const effectivePageSize = (size) => size || ALL_ROWS;

const sizeLabel = (n) => (n === 0 ? "All" : String(n));

/**
 * The page numbers to show, with "gap" markers where pages are skipped.
 * Always keeps the first page, the last page and a window around the current
 * one, so a 300-page grid still fits on one line: 1 … 148 149 [150] 151 152 … 305
 */
function pageItems(page, pages) {
  if (pages <= FULL_LIST_MAX) {
    return Array.from({ length: pages }, (_, i) => i);
  }
  const keep = new Set([0, pages - 1, page - 1, page, page + 1]);
  // Near either end, pad that side so the strip doesn't collapse to "1 … 2".
  if (page <= 2) [1, 2, 3].forEach((n) => keep.add(n));
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2].forEach((n) => keep.add(n));

  const nums = [...keep].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
  const items = [];
  nums.forEach((n, i) => {
    const prev = nums[i - 1];
    // An ellipsis hiding a single page is worse than just showing it.
    if (i > 0 && n - prev === 2) items.push(prev + 1);
    else if (i > 0 && n - prev > 2) items.push(`gap-${n}`);
    items.push(n);
  });
  return items;
}

/**
 * Rows-per-page / Prev / numbered pages / Next — rendered above AND below long
 * tables so the user never has to scroll to change page. Clicking a number jumps
 * straight to it; when there are more pages than buttons, a "Go to" box takes any
 * number. Pass `pageSize` + `onPageSizeChange` to show the rows-per-page picker.
 *
 * `page` is zero-based (matching the API); everything shown to the user is 1-based.
 */
export default function Pager({
  page,
  pages,
  total,
  unit = "row",
  disabled = false,
  onChange,
  meta = true,
  pageSize,
  onPageSizeChange,
  pageSizes = PAGE_SIZE_OPTIONS,
  maxPageSize,
}) {
  // With one page there's nothing to navigate — but the size picker still has to
  // be reachable, otherwise "All" would be a one-way door.
  const navigable = pages > 1;
  if (!navigable && !onPageSizeChange) return null;

  const go = (p) => {
    const next = Math.max(0, Math.min(pages - 1, p));
    if (next !== page) onChange(next);
  };

  const jump = (e) => {
    e.preventDefault();
    // Two Pagers render per table (above + below), so no ids here — read the
    // input off the submitted form instead.
    const n = parseInt(new FormData(e.currentTarget).get("page"), 10);
    if (!Number.isNaN(n)) go(n - 1); // the box is 1-based
    e.currentTarget.reset();
  };

  return (
    <div className="pager">
      {onPageSizeChange && (
        <label className="pager-size">
          <span className="muted small">Rows</span>
          <select
            value={pageSize}
            disabled={disabled}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            title={
              maxPageSize
                ? `How many rows to load at once ("All" loads up to ${maxPageSize})`
                : "How many rows to load at once — “All” can be slow on large files"
            }
          >
            {pageSizes.map((n) => (
              <option key={n} value={n}>
                {sizeLabel(n)}
              </option>
            ))}
          </select>
        </label>
      )}

      {navigable && (
        <>
          <button
            className="btn sm"
            disabled={page === 0 || disabled}
            onClick={() => go(page - 1)}
          >
            <Icon name="arrowLeft" size={14} /> Prev
          </button>

          <div className="pager-pages">
            {pageItems(page, pages).map((it) =>
              typeof it === "string" ? (
                <span className="pager-gap" key={it}>
                  …
                </span>
              ) : (
                <button
                  key={it}
                  className={`pager-page${it === page ? " active" : ""}`}
                  disabled={disabled}
                  aria-current={it === page ? "page" : undefined}
                  onClick={() => go(it)}
                >
                  {it + 1}
                </button>
              )
            )}
          </div>

          <button
            className="btn sm"
            disabled={page >= pages - 1 || disabled}
            onClick={() => go(page + 1)}
          >
            Next <Icon name="arrowRight" size={14} />
          </button>

          {pages > FULL_LIST_MAX && (
            <form className="pager-jump" onSubmit={jump}>
              <span className="muted small">Go to</span>
              <input
                name="page"
                type="number"
                min="1"
                max={pages}
                placeholder={String(page + 1)}
                disabled={disabled}
                aria-label={`Go to page (1 to ${pages})`}
              />
            </form>
          )}
        </>
      )}

      {meta && (
        <span className="muted small pager-meta">
          Page {page + 1} of {pages}
          {total != null && ` · ${total} ${unit}${total === 1 ? "" : "s"}`}
        </span>
      )}
    </div>
  );
}
