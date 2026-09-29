/** Opens a file picker and resolves with the file's text (null when cancelled). */
export function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}

export const parseList = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
