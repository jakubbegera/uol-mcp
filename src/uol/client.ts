import type { BinaryResponse, Query, UolHttp } from './http.js';
import type { Href, PaginationMeta } from './normalize.js';

/*
 * Raw response shapes as observed on live tenants (the spec has no response
 * schemas for most endpoints). Every field is optional; normalisation lives in
 * the tool layer.
 */

export interface Page<T> extends PaginationMeta {
  items?: T[];
}

type Ref<K extends string> = { [P in K]?: string | null } | null;

export interface RawInvoiceItem {
  id?: number;
  description?: string | null;
  quantity?: string | number | null;
  unit_price?: string | number | null;
  unit_price_vat_inclusive?: string | number | null;
  vat_rate?: number | string | null;
  percent_discount?: number | string | null;
  product?: Ref<'product_id'>;
}

interface RawInvoiceCommon {
  invoice_id?: number | string;
  gid?: number;
  public_id?: string | null;
  status?: string;
  type?: string;
  issue_date?: string | null;
  due_date?: string | null;
  tax_payment_date?: string | null;
  total_amount?: string | null;
  vat1_amount?: string | null;
  vat2_amount?: string | null;
  vat3_amount?: string | null;
  currency?: Ref<'currency_id'>;
  department?: Ref<'department_id'>;
  exchange_rate?: number | string | null;
  payment_method?: string | null;
  variable_symbol?: number | string | null;
  constant_symbol?: number | string | null;
  specific_symbol?: number | string | null;
  note?: string | null;
  external_id?: string | null;
  linked_doc_number?: string | null;
  /** False for documents that are not tax documents (e.g. proformas). */
  vat_document?: boolean | null;
  items?: RawInvoiceItem[];
}

export interface RawSalesInvoice extends RawInvoiceCommon {
  buyer?: Href;
  text?: string | null;
  cancellation_date?: string | null;
  linked_doc?: Href | null;
}

export interface RawPurchaseInvoice extends RawInvoiceCommon {
  seller?: Href;
  date_of_receipt?: string | null;
}

export interface RawReceivable {
  invoice_id?: string | number;
  invoice_public_id?: string | null;
  invoice_type?: string;
  contact_id?: string | null;
  currency_id?: string | null;
  cancelled?: boolean;
  issue_date?: string | null;
  due_date?: string | null;
  tax_payment_date?: string | null;
  total_amount?: string | null;
  paid_amount?: string | null;
  last_payment_date?: string | null;
  payments?: { timestamp?: string; currency_id?: string; amount?: string }[];
}

export interface RawAddress {
  address_id?: string;
  address_types?: string[];
  name?: string | null;
  street?: string | null;
  building_number?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country_id?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile_phone?: string | null;
  url?: string | null;
}

export interface RawContactBankAccount {
  bank_account_id?: number;
  bank_account?: string | null;
  iban?: string | null;
  default?: boolean | null;
  currency?: Ref<'currency_id'>;
}

export interface RawContact {
  contact_id?: string;
  name?: string | null;
  company_number?: string | null;
  vatin?: string | null;
  country_id?: string | null;
  taxable_person?: boolean | null;
  vat_payer?: boolean | null;
  unreliable_payer?: boolean | null;
  hidden?: boolean | null;
  note?: string | null;
  external_id?: string | null;
  days_till_due_date?: number | null;
  addresses?: RawAddress[];
  bank_accounts?: RawContactBankAccount[];
}

export interface RawCompany {
  my_company_id?: number;
  name?: string | null;
  company_number?: string | null;
  vatin?: string | null;
  street?: string | null;
  building_number?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country?: Ref<'country_id'>;
  email?: string | null;
  phone?: string | null;
  url?: string | null;
  register_text?: string | null;
  legal_entity?: boolean | null;
  vat_payer_code?: string | null;
  status?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
}

export interface RawUploadedDocument {
  id?: number;
  file?: string | null;
  content_type?: string | null;
  format?: string | null;
  state?: string | null;
  note?: string | null;
  uploaded_client?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  creator?: Ref<'user_id'>;
  document_pairings?: { document_pairable_type?: string; document_pairable_id?: number }[];
}

/** One general-ledger posting. `status: valid` means *posted* here (unlike invoices). */
export interface RawAccountingRecord {
  id?: number;
  date?: string | null;
  status?: string | null;
  debit_account?: Ref<'chart_of_account_id'>;
  credit_account?: Ref<'chart_of_account_id'>;
  /** In the document currency. */
  amount?: string | null;
  /** In the tenant's home currency — the one to aggregate. */
  accounting_amount?: string | null;
  currency?: Ref<'currency_id'>;
  description?: string | null;
  doc_type?: Ref<'document_config_id'>;
  doc_number?: number | string | null;
}

export interface RawInternalDocumentItem {
  debit_account_id?: string | null;
  credit_account_id?: string | null;
  amount?: string | null;
  accounting_amount?: string | null;
  description?: string | null;
}

export interface RawInternalDocument {
  number?: number | string;
  date?: string | null;
  note?: string | null;
  status?: string | null;
  items?: RawInternalDocumentItem[];
}

/** Monthly opening-balance snapshot of one own bank account (not a live balance). */
export interface RawBankBalance {
  bank_account_id?: string | null;
  date?: string | null;
  opening_balance?: string | null;
  currency?: Ref<'currency_id'>;
  locked?: boolean | null;
}

const id = (value: string | number) => encodeURIComponent(String(value));

/** One method per UOL endpoint the tools use. */
export class UolClient {
  constructor(readonly http: UolHttp) {}

  ping = () => this.http.getJson<{ ping?: string }>('/v1/ping');

  myCompanies = () => this.http.getJson<Page<RawCompany>>('/v1/my_companies', { per_page: 100 });

  salesInvoices = (query: Query) => this.http.getJson<Page<RawSalesInvoice>>('/v1/sales_invoices', query);
  salesInvoice = (invoiceId: string) => this.http.getJson<RawSalesInvoice>(`/v1/sales_invoices/${id(invoiceId)}`);

  /** Sales invoice rendered by UOL: `application/pdf` or `text/isdoc`. */
  exportSalesInvoice = (invoiceId: string, mediaType: string): Promise<BinaryResponse> =>
    this.http.getBinary(this.http.apiUrl(`/v1/sales_invoices/${id(invoiceId)}`), mediaType);

  purchaseInvoices = (query: Query) =>
    this.http.getJson<Page<RawPurchaseInvoice>>('/v1/purchase_invoices', query);
  purchaseInvoice = (invoiceId: string) =>
    this.http.getJson<RawPurchaseInvoice>(`/v1/purchase_invoices/${id(invoiceId)}`);

  receivables = (query: Query) => this.http.getJson<Page<RawReceivable>>('/v1/receivables', query);
  receivable = (invoiceId: string) => this.http.getJson<RawReceivable>(`/v1/receivables/${id(invoiceId)}`);

  contacts = (query: Query) => this.http.getJson<Page<RawContact>>('/v1/contacts', query);
  contact = (contactId: string) => this.http.getJson<RawContact>(`/v1/contacts/${id(contactId)}`);

  uploadedDocuments = (query: Query) =>
    this.http.getJson<Page<RawUploadedDocument>>('/v1/uploaded_documents', query);
  /** Same as the detail route plus `document_pairings`; the plain detail has no way to include them. */
  uploadedDocumentWithPairings = (documentId: string) =>
    this.http.getJson<RawUploadedDocument>(`/v1/uploaded_documents/${id(documentId)}/pairings`);
  uploadedDocumentTags = (documentId: string) =>
    this.http.getJson<Page<Record<string, unknown>>>(`/v1/uploaded_documents/${id(documentId)}/tags`);

  /** `credit_account` / `debit_account` filters match by prefix (`6` → every 6xx account). */
  accountingRecords = (query: Query) =>
    this.http.getJson<Page<RawAccountingRecord>>('/v1/accounting_records', query);
  /** No date filter exists on this endpoint. */
  internalDocuments = (query: Query) =>
    this.http.getJson<Page<RawInternalDocument>>('/v1/internal_documents', query);
  bankBalances = (query: Query) => this.http.getJson<Page<RawBankBalance>>('/v1/bank_balances', query);

  createSalesInvoice = (body: Record<string, unknown>) =>
    this.http.sendJson<RawSalesInvoice>('POST', '/v1/sales_invoices', body);
  /** Drafts only; UOL answers 403 for an issued invoice. */
  updateSalesInvoice = (invoiceId: string, body: Record<string, unknown>) =>
    this.http.sendJson<RawSalesInvoice>('PATCH', `/v1/sales_invoices/${id(invoiceId)}`, body);
  /** Multipart with `file` (PDF) and optional `note`. */
  uploadDocument = (form: FormData) => this.http.postForm<RawUploadedDocument>('/v1/uploaded_documents', form);

  list = (path: string, query: Query) => this.http.getJson<Page<Record<string, unknown>>>(path, query);
  get = (path: string, query?: Query) => this.http.getJson<unknown>(path, query);
}
