/**
 * What a saved search can look at: for each kind of record, where its rows
 * come from and the fields that can be filtered, shown and sorted. Browser
 * safe apart from the SQL text, which only the server reads. Nothing a
 * person types becomes SQL: a search names fields from this list, and their
 * values are passed as parameters.
 */

export type FieldType = "text" | "money" | "number" | "date" | "choice";

export type SearchField = {
  key: string;
  label: string;
  type: FieldType;
  /** The SQL expression for the value. */
  sql: string;
  /** For a choice: each stored value and how it reads. */
  choices?: ReadonlyArray<{ value: string; label: string }>;
  /**
   * For a choice that lives on a record's lines (tracking on an invoice):
   * the SQL that's true when any line has the value, with $value where the
   * value goes. "is" uses it and "isn't" its opposite; `sql` is then only
   * what the column shows.
   */
  matchSql?: string;
};

export type RecordType = {
  key: string;
  /** "Invoices", as the menu says it. */
  label: string;
  /** One row: "invoice". */
  singular: string;
  from: string;
  /** A condition every search of this kind keeps to, e.g. leaving out contacts that are only sales prospects. */
  baseWhere?: string;
  /** The row's id, for its link and as the last sort key. */
  idSql: string;
  /** Where a row opens; {id} is replaced with hrefIdSql's value. */
  href: string;
  hrefIdSql: string;
  /** The field holding each row's currency, when its money fields can be in different ones. */
  currencyField?: string;
  fields: readonly SearchField[];
  defaultColumns: readonly string[];
  defaultSort: { field: string; direction: "asc" | "desc" };
};

const DOCUMENT_STATUS = [
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "voided", label: "Voided" },
] as const;

const JOURNAL_ORIGINS = [
  { value: "manual", label: "Manual journal" },
  { value: "invoice", label: "Invoice" },
  { value: "bill", label: "Bill" },
  { value: "customer_payment", label: "Customer payment" },
  { value: "supplier_payment", label: "Supplier payment" },
  { value: "bank_transaction", label: "Spend or receive money" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "sales_credit_note", label: "Credit note" },
  { value: "supplier_credit_note", label: "Supplier credit note" },
  { value: "expense_claim", label: "Expense claim" },
  { value: "payroll", label: "Payroll" },
  { value: "fixed_asset_depreciation", label: "Depreciation" },
  { value: "inventory", label: "Stock" },
  { value: "spreading", label: "Spreading" },
  { value: "opening_balance", label: "Opening balances" },
  { value: "correction", label: "Correction" },
] as const;

const YES_NO = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

export const RECORD_TYPES: readonly RecordType[] = [
  {
    key: "invoice",
    label: "Invoices",
    singular: "invoice",
    from: `sales_invoices i
      join contacts c on c.id = i.contact_id
      left join salespeople sp on sp.id = i.salesperson_id
      cross join lateral (select coalesce(sum(p.amount - p.overpayment_amount), 0) as amount from customer_payments p where p.invoice_id = i.id and p.status = 'active') paid
      cross join lateral (select coalesce((select sum(a.amount) from sales_credit_note_applications a where a.invoice_id = i.id and a.status = 'active'), 0)
                               + coalesce((select sum(o.amount) from customer_overpayment_applications o where o.invoice_id = i.id and o.status = 'active'), 0) as amount) credited`,
    idSql: "i.id",
    href: "/operations/invoices/{id}",
    hrefIdSql: "i.id",
    currencyField: "currency",
    fields: [
      { key: "number", label: "Number", type: "text", sql: "i.invoice_number" },
      { key: "contact", label: "Customer", type: "text", sql: "c.name" },
      { key: "date", label: "Date", type: "date", sql: "i.invoice_date" },
      { key: "due", label: "Due date", type: "date", sql: "i.due_date" },
      { key: "reference", label: "Reference", type: "text", sql: "i.reference" },
      { key: "status", label: "Status", type: "choice", sql: "i.status", choices: DOCUMENT_STATUS },
      { key: "total", label: "Total", type: "money", sql: "i.total" },
      { key: "owing", label: "Still owing", type: "money", sql: "(case when i.status = 'approved' then i.total - paid.amount - credited.amount else 0 end)" },
      { key: "daysOverdue", label: "Days overdue", type: "number", sql: "(case when i.status = 'approved' and i.total - paid.amount - credited.amount > 0 and i.due_date < $today::date then ($today::date - i.due_date) else 0 end)" },
      { key: "currency", label: "Currency", type: "text", sql: "i.currency_code" },
      { key: "salesperson", label: "Salesperson", type: "text", sql: "sp.name" },
      { key: "createdBy", label: "Made by", type: "text", sql: "i.created_by_email" },
    ],
    defaultColumns: ["number", "contact", "date", "due", "status", "total", "owing"],
    defaultSort: { field: "date", direction: "desc" },
  },
  {
    key: "bill",
    label: "Bills",
    singular: "bill",
    from: `bills b
      join contacts c on c.id = b.contact_id
      cross join lateral (select coalesce(sum(p.amount), 0) as amount from supplier_payments p where p.bill_id = b.id and p.status = 'active') paid
      cross join lateral (select coalesce(sum(a.amount), 0) as amount from supplier_credit_note_applications a where a.bill_id = b.id and a.status = 'active') credited`,
    idSql: "b.id",
    href: "/operations/bills/{id}",
    hrefIdSql: "b.id",
    currencyField: "currency",
    fields: [
      { key: "number", label: "Supplier's number", type: "text", sql: "b.supplier_invoice_number" },
      { key: "contact", label: "Supplier", type: "text", sql: "c.name" },
      { key: "date", label: "Date", type: "date", sql: "b.bill_date" },
      { key: "due", label: "Due date", type: "date", sql: "b.due_date" },
      { key: "status", label: "Status", type: "choice", sql: "b.status", choices: DOCUMENT_STATUS },
      { key: "total", label: "Total", type: "money", sql: "b.total" },
      { key: "owing", label: "Still owing", type: "money", sql: "(case when b.status = 'approved' then b.total - paid.amount - credited.amount else 0 end)" },
      { key: "daysOverdue", label: "Days overdue", type: "number", sql: "(case when b.status = 'approved' and b.total - paid.amount - credited.amount > 0 and b.due_date < $today::date then ($today::date - b.due_date) else 0 end)" },
      { key: "currency", label: "Currency", type: "text", sql: "b.currency_code" },
      { key: "createdBy", label: "Made by", type: "text", sql: "b.created_by_email" },
    ],
    defaultColumns: ["number", "contact", "date", "due", "status", "total", "owing"],
    defaultSort: { field: "date", direction: "desc" },
  },
  {
    key: "journal_line",
    label: "Ledger lines",
    singular: "ledger line",
    from: `ledger_journal_lines l
      join ledger_journals j on j.id = l.journal_id
      join accounts a on a.id = l.account_id`,
    idSql: "l.id",
    href: "/operations/ledger-journals?journal={id}",
    hrefIdSql: "j.id",
    fields: [
      { key: "date", label: "Date", type: "date", sql: "j.posting_date" },
      { key: "reference", label: "Reference", type: "text", sql: "j.reference" },
      { key: "accountCode", label: "Account code", type: "text", sql: "a.code" },
      { key: "account", label: "Account", type: "text", sql: "a.name" },
      { key: "description", label: "Description", type: "text", sql: "coalesce(nullif(l.description, ''), j.description)" },
      { key: "debit", label: "Debit", type: "money", sql: "l.debit_amount" },
      { key: "credit", label: "Credit", type: "money", sql: "l.credit_amount" },
      { key: "origin", label: "Came from", type: "choice", sql: "j.origin", choices: JOURNAL_ORIGINS },
      { key: "postedBy", label: "Posted by", type: "text", sql: "j.created_by_email" },
    ],
    defaultColumns: ["date", "reference", "accountCode", "account", "description", "debit", "credit"],
    defaultSort: { field: "date", direction: "desc" },
  },
  {
    key: "bank_transaction",
    label: "Money spent and received",
    singular: "transaction",
    from: `bank_transactions t
      join accounts a on a.id = t.account_id
      left join contacts c on c.id = t.contact_id`,
    idSql: "t.id",
    href: "/operations/bank-transactions/{id}",
    hrefIdSql: "t.id",
    currencyField: "currency",
    fields: [
      { key: "date", label: "Date", type: "date", sql: "t.transaction_date" },
      { key: "kind", label: "Spent or received", type: "choice", sql: "t.kind", choices: [{ value: "spend", label: "Spent" }, { value: "receive", label: "Received" }] },
      { key: "contact", label: "Who", type: "text", sql: "c.name" },
      { key: "reference", label: "Reference", type: "text", sql: "t.reference" },
      { key: "bankAccount", label: "Bank account", type: "text", sql: "a.name" },
      { key: "total", label: "Total", type: "money", sql: "t.total" },
      { key: "status", label: "Status", type: "choice", sql: "t.status", choices: [{ value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
      { key: "currency", label: "Currency", type: "text", sql: "t.currency_code" },
      { key: "createdBy", label: "Made by", type: "text", sql: "t.created_by_email" },
    ],
    defaultColumns: ["date", "kind", "contact", "reference", "bankAccount", "total", "status"],
    defaultSort: { field: "date", direction: "desc" },
  },
  {
    key: "contact",
    label: "Contacts",
    singular: "contact",
    from: "contacts c",
    // Someone who is only a sales prospect belongs to the CRM, which has its own lists and its own access.
    baseWhere: "(c.is_customer or c.is_supplier)",
    idSql: "c.id",
    href: "/operations/contacts",
    hrefIdSql: "c.id",
    fields: [
      { key: "name", label: "Name", type: "text", sql: "c.name" },
      { key: "email", label: "Email", type: "text", sql: "c.email" },
      { key: "phone", label: "Phone", type: "text", sql: "c.phone" },
      { key: "customer", label: "Customer", type: "choice", sql: "c.is_customer::text", choices: YES_NO },
      { key: "supplier", label: "Supplier", type: "choice", sql: "c.is_supplier::text", choices: YES_NO },
      { key: "gstNumber", label: "GST number", type: "text", sql: "c.gst_number" },
      { key: "address", label: "Postal address", type: "text", sql: "c.postal_address" },
      { key: "archived", label: "Archived", type: "choice", sql: "c.is_archived::text", choices: YES_NO },
      { key: "added", label: "Added", type: "date", sql: "(c.created_at)::date" },
    ],
    defaultColumns: ["name", "email", "phone", "customer", "supplier"],
    defaultSort: { field: "name", direction: "asc" },
  },
  {
    key: "item",
    label: "Items",
    singular: "item",
    from: "items it",
    idSql: "it.id",
    href: "/operations/items",
    hrefIdSql: "it.id",
    fields: [
      { key: "code", label: "Code", type: "text", sql: "it.code" },
      { key: "name", label: "Name", type: "text", sql: "it.name" },
      { key: "description", label: "Description", type: "text", sql: "it.description" },
      {
        key: "type",
        label: "Kind",
        type: "choice",
        sql: "it.item_type",
        choices: [
          { value: "service", label: "Service" },
          { value: "non_stock", label: "Not tracked" },
          { value: "stock", label: "Stock" },
          { value: "kit", label: "Kit" },
        ],
      },
      { key: "salePrice", label: "Sale price", type: "number", sql: "it.sale_price" },
      { key: "purchasePrice", label: "Purchase price", type: "number", sql: "it.purchase_price" },
      { key: "active", label: "Active", type: "choice", sql: "it.is_active::text", choices: YES_NO },
    ],
    defaultColumns: ["code", "name", "type", "salePrice", "purchasePrice"],
    defaultSort: { field: "code", direction: "asc" },
  },
];

export function recordType(key: unknown, types: readonly RecordType[] = RECORD_TYPES): RecordType | null {
  return types.find((type) => type.key === key) ?? null;
}

export function fieldOf(type: RecordType, key: unknown): SearchField | null {
  return type.fields.find((field) => field.key === key) ?? null;
}

/** The ways each kind of field can be filtered, in the order the screen offers them. */
export const OPERATORS: Record<FieldType, ReadonlyArray<{ op: string; label: string; values: 0 | 1 | 2 }>> = {
  text: [
    { op: "contains", label: "contains", values: 1 },
    { op: "is", label: "is exactly", values: 1 },
    { op: "starts", label: "starts with", values: 1 },
    { op: "empty", label: "is empty", values: 0 },
    { op: "not_empty", label: "has something", values: 0 },
  ],
  money: [
    { op: "gt", label: "is more than", values: 1 },
    { op: "gte", label: "is at least", values: 1 },
    { op: "lt", label: "is less than", values: 1 },
    { op: "lte", label: "is at most", values: 1 },
    { op: "eq", label: "is exactly", values: 1 },
    { op: "between", label: "is between", values: 2 },
  ],
  number: [
    { op: "gt", label: "is more than", values: 1 },
    { op: "gte", label: "is at least", values: 1 },
    { op: "lt", label: "is less than", values: 1 },
    { op: "lte", label: "is at most", values: 1 },
    { op: "eq", label: "is exactly", values: 1 },
    { op: "between", label: "is between", values: 2 },
  ],
  date: [
    { op: "within", label: "is in", values: 1 },
    { op: "on", label: "is on", values: 1 },
    { op: "before", label: "is before", values: 1 },
    { op: "after", label: "is after", values: 1 },
    { op: "between", label: "is between", values: 2 },
  ],
  choice: [
    { op: "is", label: "is", values: 1 },
    { op: "is_not", label: "isn't", values: 1 },
  ],
};

/** The moving date ranges "is in" offers; each is worked out from today when the search runs. */
export const DATE_RANGES = [
  { value: "today", label: "today" },
  { value: "this_month", label: "this month" },
  { value: "last_month", label: "last month" },
  { value: "last_7", label: "the last 7 days" },
  { value: "last_30", label: "the last 30 days" },
  { value: "last_90", label: "the last 90 days" },
  { value: "next_30", label: "the next 30 days" },
  { value: "past", label: "the past (before today)" },
] as const;
