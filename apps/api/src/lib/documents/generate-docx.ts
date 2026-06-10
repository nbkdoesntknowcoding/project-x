import { md2docx } from '@m2d/md2docx';

export interface DocxGenerationOptions {
  title?:  string;
  author?: string;
}

export async function generateDocx(
  markdown: string,
  options: DocxGenerationOptions = {},
): Promise<Buffer> {
  const result = await md2docx(
    markdown,
    {
      title:   options.title ?? 'Mnema Document',
      creator: options.author ?? 'Mnema — theboringpeople.in',
    },
    undefined,
    'nodebuffer',
  );

  return result as Buffer;
}
