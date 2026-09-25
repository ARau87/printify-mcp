/** The documented `POST /v1/uploads/images.json` response. */
export const UPLOAD = {
  id: '5941187eb8e7e37b3f0e62e5',
  file_name: 'image.png',
  height: 200,
  width: 400,
  size: 1021,
  mime_type: 'image/png',
  preview_url: 'https://example.com/image-storage/uuid3',
  upload_time: '2020-01-09 07:29:43',
};

/** The first documented `GET /v1/uploads.json` item. */
export const UPLOAD_LISTED = {
  id: '5e16d66791287a0006e522b2',
  file_name: 'png-images-logo-1.jpg',
  height: 5979,
  width: 17045,
  size: 1138575,
  mime_type: 'image/png',
  preview_url: 'https://example.com/image-storage/uuid1',
  upload_time: '2020-01-09 07:29:43',
};

export function upload(overrides: Partial<typeof UPLOAD> = {}): typeof UPLOAD {
  return { ...UPLOAD, ...overrides };
}

/** The documented paginated envelope, around `items`. */
export function uploadsPage(
  items: readonly object[] = [UPLOAD_LISTED],
  overrides: { current_page?: number; last_page?: number; total?: number } = {},
): object {
  const { current_page = 1, last_page = 1, total = items.length } = overrides;
  return {
    current_page,
    data: items,
    first_page_url: '/?page=1',
    from: 1,
    last_page,
    last_page_url: `/?page=${String(last_page)}`,
    next_page_url: current_page < last_page ? `/?page=${String(current_page + 1)}` : null,
    path: '/',
    per_page: 10,
    prev_page_url: null,
    to: items.length,
    total,
  };
}
