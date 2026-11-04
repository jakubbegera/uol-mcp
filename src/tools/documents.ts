import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { safeFileName } from '../domain/files.js';
import type { RawUploadedDocument } from '../uol/client.js';
import { UolApiError } from '../uol/errors.js';
import { pageInfo, refId, stripNoise, str } from '../uol/normalize.js';
import { type ToolContext, registerReadTool } from './context.js';
import { deliverFile } from './files.js';
import { isoDate, limitArg, pageArg, pageInfo as pageInfoSchema, savedFile } from './schemas.js';

const STATES = ['unprocessed', 'processed', 'error'] as const;

const documentRow = z.object({
  document_id: z.string(),
  state: z.string().nullable().describe('unprocessed = waiting for the accountant, processed, error'),
  note: z.string().nullable(),
  format: z.string().nullable(),
  content_type: z.string().nullable(),
  uploaded_via: z.string().nullable().describe('web, api, an e-mail address or an OIDC client id'),
  created_at: z.string().nullable(),
  created_by: z.string().nullable(),
});

function rowOf(doc: RawUploadedDocument): z.output<typeof documentRow> {
  return {
    document_id: String(doc.id ?? ''),
    state: str(doc.state),
    note: str(doc.note),
    format: str(doc.format),
    content_type: str(doc.content_type),
    uploaded_via: str(doc.uploaded_client),
    created_at: str(doc.created_at),
    created_by: refId(doc.creator, 'user_id'),
  };
}

export function registerDocumentTools(server: McpServer, ctx: ToolContext): void {
  registerReadTool(
    server,
    ctx,
    'list_uploaded_documents',
    {
      title: 'List uploaded documents',
      description:
        'Documents uploaded to UOL for the accountant (nahrané doklady: receipts, received invoices as PDF/images), newest first. ' +
        'state=unprocessed lists what the accountant has not processed yet.',
      input: z.object({
        state: z.enum(STATES).optional(),
        created_from: isoDate.optional().describe('Uploaded on or after this day (Prague time)'),
        created_to: isoDate.optional().describe('Uploaded before this day (Prague time)'),
        page: pageArg,
        limit: limitArg(),
      }),
      output: z.object({ documents: z.array(documentRow), pagination: pageInfoSchema }),
    },
    async (args, { client }) => {
      const body = await client.uploadedDocuments({
        state: args.state,
        created_at_from: args.created_from,
        created_at_to: args.created_to,
        page: args.page,
        per_page: args.limit,
      });
      return {
        data: {
          documents: (body.items ?? []).map(rowOf),
          pagination: pageInfo(body, args.page, args.limit),
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'get_uploaded_document',
    {
      title: 'Get uploaded document',
      description:
        'One uploaded document with its original file name, tags and the bookkeeping records it was paired with. ' +
        'Pairings identify the record by type and internal gid, not by invoice number.',
      input: z.object({ document_id: z.string() }),
      output: documentRow.extend({
        file_name: z.string().nullable(),
        pairings: z.array(z.object({ type: z.string().nullable(), gid: z.number().nullable() })),
        tags: z.array(z.record(z.string(), z.unknown())).nullable().describe('Null when the UOL user may not read tags'),
      }),
    },
    async ({ document_id }, { client }) => {
      const doc = await client.uploadedDocumentWithPairings(document_id);
      const [fileName, tags] = await Promise.all([
        doc.file ? client.http.peekFileName(client.http.resolveFileUrl(doc.file)) : Promise.resolve(undefined),
        client
          .uploadedDocumentTags(document_id)
          .then((body) => (body.items ?? []).map(stripNoise))
          .catch(() => null),
      ]);
      return {
        data: {
          ...rowOf(doc),
          file_name: fileName ?? null,
          pairings: (doc.document_pairings ?? []).map((p) => ({
            type: str(p.document_pairable_type),
            gid: p.document_pairable_id ?? null,
          })),
          tags,
        },
      };
    },
  );

  registerReadTool(
    server,
    ctx,
    'download_uploaded_document',
    {
      title: 'Download uploaded document',
      description: 'Saves the original file of an uploaded document on the machine running uol-mcp and returns its path.',
      input: z.object({ document_id: z.string() }),
      output: savedFile.extend({ document_id: z.string() }),
    },
    async ({ document_id }, { client, config }) => {
      const doc = await client.uploadedDocumentWithPairings(document_id);
      if (!doc.file) throw new UolApiError('This document has no file attached.', 404, '0004');
      let file;
      try {
        file = await client.http.getBinary(client.http.resolveFileUrl(doc.file));
      } catch (error) {
        if (error instanceof UolApiError && error.status === 404) {
          throw new UolApiError(
            'The file is no longer on the UOL server (UOL periodically removes stored files but keeps the record).',
            404,
            error.code,
          );
        }
        throw error;
      }
      const extension = str(doc.format) ?? 'pdf';
      const name = safeFileName(file.fileName, `doklad-${document_id}.${extension}`);
      const { path, blocks } = await deliverFile(config, name, file.bytes, file.contentType);
      return {
        data: {
          document_id,
          file_path: path,
          file_name: name,
          content_type: file.contentType,
          size_bytes: file.bytes.length,
        },
        extra: blocks,
      };
    },
  );
}
