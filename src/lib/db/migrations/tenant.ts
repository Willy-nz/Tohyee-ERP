import type { Migration } from "@/lib/db/migrations/types";
import { migration as m0001 } from "@/lib/db/migrations/tenant/0001-tenant-baseline";
import { migration as m0002 } from "@/lib/db/migrations/tenant/0002-contacts";
import { migration as m0003 } from "@/lib/db/migrations/tenant/0003-sales-invoices";
import { migration as m0004 } from "@/lib/db/migrations/tenant/0004-customer-payments";
import { migration as m0005 } from "@/lib/db/migrations/tenant/0005-bills";
import { migration as m0006 } from "@/lib/db/migrations/tenant/0006-supplier-payments";
import { migration as m0007 } from "@/lib/db/migrations/tenant/0007-sales-credit-notes";
import { migration as m0008 } from "@/lib/db/migrations/tenant/0008-supplier-credit-notes";
import { migration as m0009 } from "@/lib/db/migrations/tenant/0009-gst-returns";
import { migration as m0010 } from "@/lib/db/migrations/tenant/0010-customer-overpayments";
import { migration as m0011 } from "@/lib/db/migrations/tenant/0011-bank-accounts-and-reconciliation";
import { migration as m0012 } from "@/lib/db/migrations/tenant/0012-gst-payments-and-hybrid-bases";
import { migration as m0013 } from "@/lib/db/migrations/tenant/0013-record-notes-and-attachments";
import { migration as m0014 } from "@/lib/db/migrations/tenant/0014-payments-for-several-documents";
import { migration as m0015 } from "@/lib/db/migrations/tenant/0015-custom-reports";
import { migration as m0016 } from "@/lib/db/migrations/tenant/0016-tracking-categories";
import { migration as m0017 } from "@/lib/db/migrations/tenant/0017-custom-fields";
import { migration as m0018 } from "@/lib/db/migrations/tenant/0018-salespeople";
import { migration as m0019 } from "@/lib/db/migrations/tenant/0019-crm";
import { migration as m0020 } from "@/lib/db/migrations/tenant/0020-crm-mail";
import { migration as m0021 } from "@/lib/db/migrations/tenant/0021-richer-customers";
import { migration as m0022 } from "@/lib/db/migrations/tenant/0022-items";
import { migration as m0023 } from "@/lib/db/migrations/tenant/0023-stock-tracking";
import { migration as m0024 } from "@/lib/db/migrations/tenant/0024-sales-documents";
import { migration as m0025 } from "@/lib/db/migrations/tenant/0025-purchase-orders";
import { migration as m0026 } from "@/lib/db/migrations/tenant/0026-stock-transfers";
import { migration as m0027 } from "@/lib/db/migrations/tenant/0027-budgets";
import { migration as m0028 } from "@/lib/db/migrations/tenant/0028-expense-claims";
import { migration as m0029 } from "@/lib/db/migrations/tenant/0029-fixed-assets";
import { migration as m0030 } from "@/lib/db/migrations/tenant/0030-projects";
import { migration as m0031 } from "@/lib/db/migrations/tenant/0031-standard-tax-codes";
import { migration as m0032 } from "@/lib/db/migrations/tenant/0032-bank-reconciliation-splits";
import { migration as m0033 } from "@/lib/db/migrations/tenant/0033-foreign-currency-bank-accounts";
import { migration as m0034 } from "@/lib/db/migrations/tenant/0034-bringing-in-existing-books";
import { migration as m0035 } from "@/lib/db/migrations/tenant/0035-document-emails";
import { migration as m0036 } from "@/lib/db/migrations/tenant/0036-opening-gst-and-historical-adjustment";
import { migration as m0037 } from "@/lib/db/migrations/tenant/0037-microsoft-sending-and-logo";
import { migration as m0038 } from "@/lib/db/migrations/tenant/0038-opening-balance-account-name";
import { migration as m0039 } from "@/lib/db/migrations/tenant/0039-period-close";
import { migration as m0040 } from "@/lib/db/migrations/tenant/0040-repeating-bills";
import { migration as m0041 } from "@/lib/db/migrations/tenant/0041-netsuite-followups";
import { migration as m0042 } from "@/lib/db/migrations/tenant/0042-multi-currency-documents";
import { migration as m0043 } from "@/lib/db/migrations/tenant/0043-multi-currency-settlements";
import { migration as m0044 } from "@/lib/db/migrations/tenant/0044-google-sending";
import { migration as m0045 } from "@/lib/db/migrations/tenant/0045-fx-rounding-and-document-revaluation";
import { migration as m0046 } from "@/lib/db/migrations/tenant/0046-currency-exchange-rates";
import { migration as m0047 } from "@/lib/db/migrations/tenant/0047-foreign-currency-projects-crm";
import { migration as m0048 } from "@/lib/db/migrations/tenant/0048-exports-tax-code";
import { migration as m0049 } from "@/lib/db/migrations/tenant/0049-contact-purchase-tax-code";
import { migration as m0050 } from "@/lib/db/migrations/tenant/0050-tax-code-available-on";
import { migration as m0051 } from "@/lib/db/migrations/tenant/0051-payroll-employees";
import { migration as m0052 } from "@/lib/db/migrations/tenant/0052-not-for-profit-module";
import { migration as m0053 } from "@/lib/db/migrations/tenant/0053-crm-custom-fields";
import { migration as m0057 } from "@/lib/db/migrations/tenant/0057-payroll-allocation-rates-access";
import { migration as m0055 } from "@/lib/db/migrations/tenant/0055-sales-orders";
import { migration as m0056 } from "@/lib/db/migrations/tenant/0056-sales-platform-connections";
import { migration as m0059 } from "@/lib/db/migrations/tenant/0059-crm-record-types";
import { migration as m0060 } from "@/lib/db/migrations/tenant/0060-rdti-register-and-tags";
import { migration as m0058 } from "@/lib/db/migrations/tenant/0058-payroll-pay-runs";
import { migration as m0062 } from "@/lib/db/migrations/tenant/0062-payroll-payments";
import { migration as m0061 } from "@/lib/db/migrations/tenant/0061-sales-platform-orders";
import { migration as m0063 } from "@/lib/db/migrations/tenant/0063-payroll-bank-files-and-payslips";
import { migration as m0064 } from "@/lib/db/migrations/tenant/0064-payroll-payday-filing-settings";
import { migration as m0065 } from "@/lib/db/migrations/tenant/0065-rdti-claim-report";
import { migration as m0066 } from "@/lib/db/migrations/tenant/0066-crm-opportunity-stages";
import { migration as m0067 } from "@/lib/db/migrations/tenant/0067-payroll-timesheets";
import { migration as m0068 } from "@/lib/db/migrations/tenant/0068-payroll-workforce-budgets";
import { migration as m0069 } from "@/lib/db/migrations/tenant/0069-payroll-extra-back-final-pays";
import { migration as m0070 } from "@/lib/db/migrations/tenant/0070-payroll-holidays-act-leave";
import { migration as m0071 } from "@/lib/db/migrations/tenant/0071-payroll-leave-opening-balances-and-requests";
import { migration as m0072 } from "@/lib/db/migrations/tenant/0072-payroll-leave-liability-postings";
import { migration as m0073 } from "@/lib/db/migrations/tenant/0073-payroll-leave-liability-kiwisaver";
import { migration as m0074 } from "@/lib/db/migrations/tenant/0074-payroll-week-settings";
import { migration as m0075 } from "@/lib/db/migrations/tenant/0075-sales-platform-guest-contact";
import { migration as m0076 } from "@/lib/db/migrations/tenant/0076-purchase-order-close";
import { migration as m0077 } from "@/lib/db/migrations/tenant/0077-expense-claim-receipt-gst-number";
import { migration as m0078 } from "@/lib/db/migrations/tenant/0078-payroll-pay-run-bank-account";
import { migration as m0079 } from "@/lib/db/migrations/tenant/0079-crm-opportunity-sales-order";
import { migration as m0080 } from "@/lib/db/migrations/tenant/0080-default-payment-terms";
import { migration as m0081 } from "@/lib/db/migrations/tenant/0081-ledger-journal-drafts";
import { migration as m0082 } from "@/lib/db/migrations/tenant/0082-analytics-sources-and-loads";
import { migration as m0083 } from "@/lib/db/migrations/tenant/0083-analytics-dashboards";
import { migration as m0084 } from "@/lib/db/migrations/tenant/0084-gst-late-claims";
import { migration as m0085 } from "@/lib/db/migrations/tenant/0085-analytics-dashboard-shares";
import { migration as m0086 } from "@/lib/db/migrations/tenant/0086-custom-transaction-reports";
import { migration as m0087 } from "@/lib/db/migrations/tenant/0087-analytics-shaped-tables";
import { migration as m0088 } from "@/lib/db/migrations/tenant/0088-analytics-report-emails";
import { migration as m0089 } from "@/lib/db/migrations/tenant/0089-dashboard-preferences";
import { migration as m0090 } from "@/lib/db/migrations/tenant/0090-analytics-source-excel-sheets";
import { migration as m0091 } from "@/lib/db/migrations/tenant/0091-bank-rule-conditions-lines-and-contact-defaults";
import { migration as m0092 } from "@/lib/db/migrations/tenant/0092-bank-file-feeds";
import { migration as m0093 } from "@/lib/db/migrations/tenant/0093-simplefin-feeds";
import { migration as m0094 } from "@/lib/db/migrations/tenant/0094-stripe-feeds";
import { migration as m0095 } from "@/lib/db/migrations/tenant/0095-paypal-feeds";
import { migration as m0096 } from "@/lib/db/migrations/tenant/0096-wise-feeds";
import { migration as m0097 } from "@/lib/db/migrations/tenant/0097-bills-inbox-and-mileage";
import { migration as m0098 } from "@/lib/db/migrations/tenant/0098-online-payments";
import { migration as m0099 } from "@/lib/db/migrations/tenant/0099-online-payments-paypal";
import { migration as m0100 } from "@/lib/db/migrations/tenant/0100-approval-workflows";
import { migration as m0101 } from "@/lib/db/migrations/tenant/0101-cash-flow-forecast";
import { migration as m0102 } from "@/lib/db/migrations/tenant/0102-intercompany-and-ecb-rates";
import { migration as m0103 } from "@/lib/db/migrations/tenant/0103-report-commentaries";
import { migration as m0104 } from "@/lib/db/migrations/tenant/0104-shopify-chargebacks-and-reserves";
import { migration as m0105 } from "@/lib/db/migrations/tenant/0105-woocommerce-orders";
import { migration as m0106 } from "@/lib/db/migrations/tenant/0106-payroll-details-changed-on-drafts";
import { migration as m0107 } from "@/lib/db/migrations/tenant/0107-payroll-kiwisaver-temporary-rate-reduction";
import { migration as m0108 } from "@/lib/db/migrations/tenant/0108-fx-revaluation-voids";
import { migration as m0109 } from "@/lib/db/migrations/tenant/0109-gst-registration";
import { migration as m0110 } from "@/lib/db/migrations/tenant/0110-exchange-rate-sources";
import { migration as m0111 } from "@/lib/db/migrations/tenant/0111-accounting-module";
import { migration as m0112 } from "@/lib/db/migrations/tenant/0112-several-feed-logins";
import { migration as m0113 } from "@/lib/db/migrations/tenant/0113-gocardless-direct-debit";
import { migration as m0114 } from "@/lib/db/migrations/tenant/0114-crm-sales-teams";
import { migration as m0115 } from "@/lib/db/migrations/tenant/0115-crm-leads";
import { migration as m0116 } from "@/lib/db/migrations/tenant/0116-crm-lead-intake";
import { migration as m0117 } from "@/lib/db/migrations/tenant/0117-crm-duplicates";
import { migration as m0118 } from "@/lib/db/migrations/tenant/0118-crm-follow-up-rules";
import { migration as m0119 } from "@/lib/db/migrations/tenant/0119-crm-sales-email";
import { migration as m0120 } from "@/lib/db/migrations/tenant/0120-crm-sequences";
import { migration as m0121 } from "@/lib/db/migrations/tenant/0121-crm-campaigns";
import { migration as m0122 } from "@/lib/db/migrations/tenant/0122-crm-team-forecasts";
import { migration as m0123 } from "@/lib/db/migrations/tenant/0123-sales-line-discounts";
import { migration as m0124 } from "@/lib/db/migrations/tenant/0124-crm-deal-products";
import { migration as m0125 } from "@/lib/db/migrations/tenant/0125-livestock-movements";
import { migration as m0126 } from "@/lib/db/migrations/tenant/0126-livestock-valuations";
import { migration as m0127 } from "@/lib/db/migrations/tenant/0127-livestock-account-sales";
import { migration as m0128 } from "@/lib/db/migrations/tenant/0128-livestock-stage-4";
import { migration as m0129 } from "@/lib/db/migrations/tenant/0129-jobs-and-visits";
import { migration as m0130 } from "@/lib/db/migrations/tenant/0130-rosters";
import { migration as m0131 } from "@/lib/db/migrations/tenant/0131-clocking-in";
import { migration as m0132 } from "@/lib/db/migrations/tenant/0132-rd-income-year-early-balance-date";
import { migration as m0133 } from "@/lib/db/migrations/tenant/0133-farming";
import { migration as m0134 } from "@/lib/db/migrations/tenant/0134-fertiliser-planner";
import { migration as m0135 } from "@/lib/db/migrations/tenant/0135-farm-imagery";
import { migration as m0136 } from "@/lib/db/migrations/tenant/0136-soil-tests";
import { migration as m0137 } from "@/lib/db/migrations/tenant/0137-roster-emails";
import { migration as m0138 } from "@/lib/db/migrations/tenant/0138-akahu-account-numbers";
import { migration as m0139 } from "@/lib/db/migrations/tenant/0139-livestock-rations";
import { migration as m0140 } from "@/lib/db/migrations/tenant/0140-landed-cost-allocations";
import { migration as m0141 } from "@/lib/db/migrations/tenant/0141-recoding";
import { migration as m0142 } from "@/lib/db/migrations/tenant/0142-farm-benchmarks";
import { migration as m0143 } from "@/lib/db/migrations/tenant/0143-financial-statement-notes";
import { migration as m0144 } from "@/lib/db/migrations/tenant/0144-ai-farm-workspace";
import { migration as m0145 } from "@/lib/db/migrations/tenant/0145-repeating-price-changes";
import { migration as m0146 } from "@/lib/db/migrations/tenant/0146-performance-reports";
import { migration as m0147 } from "@/lib/db/migrations/tenant/0147-free-and-negative-sales-lines";
import { migration as m0148 } from "@/lib/db/migrations/tenant/0148-free-and-negative-purchase-lines";
import { migration as m0149 } from "@/lib/db/migrations/tenant/0149-history-imports";
import { migration as m0150 } from "@/lib/db/migrations/tenant/0150-income-tax";
import { migration as m0151 } from "@/lib/db/migrations/tenant/0151-fixed-asset-tax-details";
import { migration as m0152 } from "@/lib/db/migrations/tenant/0152-ir10";
import { migration as m0153 } from "@/lib/db/migrations/tenant/0153-imputation-credit-account";
import { migration as m0154 } from "@/lib/db/migrations/tenant/0154-ird-documents";
import { migration as m0155 } from "@/lib/db/migrations/tenant/0155-income-tax-payments-from-books";
import { migration as m0156 } from "@/lib/db/migrations/tenant/0156-income-tax-imputation-and-overseas-credits";
import { migration as m0157 } from "@/lib/db/migrations/tenant/0157-income-tax-imputation-brought-forward";
import { migration as m0158 } from "@/lib/db/migrations/tenant/0158-pasture-and-feed";
import { migration as m0159 } from "@/lib/db/migrations/tenant/0159-soil-samples";
import { migration as m0160 } from "@/lib/db/migrations/tenant/0160-sick-leave-expectations";
import { migration as m0161 } from "@/lib/db/migrations/tenant/0161-livestock-reporting";
import { migration as m0162 } from "@/lib/db/migrations/tenant/0162-farm-calendar";
import { migration as m0163 } from "@/lib/db/migrations/tenant/0163-farm-calendar-own-items-sharing-links";
import { migration as m0164 } from "@/lib/db/migrations/tenant/0164-farm-mail-folders";
import { migration as m0165 } from "@/lib/db/migrations/tenant/0165-analytics-measures";
import { migration as m0166 } from "@/lib/db/migrations/tenant/0166-analytics-database-connections";
import { migration as m0167 } from "@/lib/db/migrations/tenant/0167-analytics-google-analytics";
import { migration as m0168 } from "@/lib/db/migrations/tenant/0168-private-mail";
import { migration as m0169 } from "@/lib/db/migrations/tenant/0169-private-mail-ai-keys";
import { migration as m0170 } from "@/lib/db/migrations/tenant/0170-income-tax-payment-allocations";
import { migration as m0171 } from "@/lib/db/migrations/tenant/0171-livestock-rations-adjustments";
import { migration as m0172 } from "@/lib/db/migrations/tenant/0172-coop-share-register";
import { migration as m0174 } from "@/lib/db/migrations/tenant/0174-crm-lead-replies";
import { migration as m0175 } from "@/lib/db/migrations/tenant/0175-crm-account-plans-and-renewals";
import { migration as m0173 } from "@/lib/db/migrations/tenant/0173-group-steward-records";
import { migration as m0176 } from "@/lib/db/migrations/tenant/0176-analytics-report-themes";
import { migration as m0177 } from "@/lib/db/migrations/tenant/0177-analytics-dashboard-images";
import { migration as m0180 } from "@/lib/db/migrations/tenant/0180-private-mail-filing";
import { migration as m0179 } from "@/lib/db/migrations/tenant/0179-ird-imports";
import { migration as m0182 } from "@/lib/db/migrations/tenant/0182-farm-reporting";
import { migration as m0183 } from "@/lib/db/migrations/tenant/0183-farm-member-access";
import { migration as m0178 } from "@/lib/db/migrations/tenant/0178-analytics-dashboard-versions";
import { migration as m0184 } from "@/lib/db/migrations/tenant/0184-analytics-fields";
import { migration as m0185 } from "@/lib/db/migrations/tenant/0185-analytics-relationships-and-field-settings";
import { migration as m0186 } from "@/lib/db/migrations/tenant/0186-farm-last-used";
import { migration as m0187 } from "@/lib/db/migrations/tenant/0187-farm-app-launchers";
import { migration as m0188 } from "@/lib/db/migrations/tenant/0188-farm-record-operation-ids";
import { migration as m0189 } from "@/lib/db/migrations/tenant/0189-farm-safety-records";
import { migration as m0190 } from "@/lib/db/migrations/tenant/0190-farm-safety-site-links";
import { migration as m0191 } from "@/lib/db/migrations/tenant/0191-farm-safety-weekly-copy";
import { migration as m0193 } from "@/lib/db/migrations/tenant/0193-safety-file-place";
import { migration as m0197 } from "@/lib/db/migrations/tenant/0197-tractor-mode";
import { migration as m0199 } from "@/lib/db/migrations/tenant/0199-farm-imagery-key-saved-at";
import { migration as m0200 } from "@/lib/db/migrations/tenant/0200-farm-effluent-records";
import { migration as m0201 } from "@/lib/db/migrations/tenant/0201-farm-effluent-tanker-and-copy";
import { migration as m0202 } from "@/lib/db/migrations/tenant/0202-farm-effluent-copy-default";
import { migration as m0205 } from "@/lib/db/migrations/tenant/0205-tractor-job-versions";
import { migration as m0207 } from "@/lib/db/migrations/tenant/0207-farm-location-shares";
import { migration as m0209 } from "@/lib/db/migrations/tenant/0209-pasture-photos";
import { migration as m0210 } from "@/lib/db/migrations/tenant/0210-analytics-google-search-console";
import { migration as m0211 } from "@/lib/db/migrations/tenant/0211-analytics-meta";
import { migration as m0212 } from "@/lib/db/migrations/tenant/0212-security-cameras";
import { migration as m0213 } from "@/lib/db/migrations/tenant/0213-security-postbox";
import { migration as m0214 } from "@/lib/db/migrations/tenant/0214-sales-platform-shopify-extras";
import { migration as m0215 } from "@/lib/db/migrations/tenant/0215-sales-platform-customer-matches";
import { migration as m0216 } from "@/lib/db/migrations/tenant/0216-gst-registration-confirmed";
import { migration as m0217 } from "@/lib/db/migrations/tenant/0217-akahu-sync-results";
import { migration as m0218 } from "@/lib/db/migrations/tenant/0218-batches";
import { migration as m0219 } from "@/lib/db/migrations/tenant/0219-sales-platform-payouts";
import { migration as m0220 } from "@/lib/db/migrations/tenant/0220-bank-coding-proposals";
import { migration as m0221 } from "@/lib/db/migrations/tenant/0221-mixed-use-accounts";
import { migration as m0222 } from "@/lib/db/migrations/tenant/0222-sales-platform-payouts-recheck";
import { migration as m0223 } from "@/lib/db/migrations/tenant/0223-sales-platform-buyers-only";
import { migration as m0225 } from "@/lib/db/migrations/tenant/0225-report-layouts-and-favourites";
import { migration as m0226 } from "@/lib/db/migrations/tenant/0226-sales-platform-freshness-and-settlements";
import { migration as m0227 } from "@/lib/db/migrations/tenant/0227-signing-requests";
import { migration as m0228 } from "@/lib/db/migrations/tenant/0228-signing-source-details";
import { migration as m0229 } from "@/lib/db/migrations/tenant/0229-signing-reminders";
import { migration as m0230 } from "@/lib/db/migrations/tenant/0230-analytics-dashboard-history";
import { migration as m0233 } from "@/lib/db/migrations/tenant/0233-farm-mobs";
import { migration as m0234 } from "@/lib/db/migrations/tenant/0234-farm-treatments";
import { migration as m0235 } from "@/lib/db/migrations/tenant/0235-farm-breeding-rotation";
import { migration as m0236 } from "@/lib/db/migrations/tenant/0236-farm-terms-grazing-import";
import { migration as m0237 } from "@/lib/db/migrations/tenant/0237-farm-animals";
import { migration as m0238 } from "@/lib/db/migrations/tenant/0238-animal-weights";
import { migration as m0239 } from "@/lib/db/migrations/tenant/0239-body-condition-scores";
import { migration as m0240 } from "@/lib/db/migrations/tenant/0240-bcs-suggestions-references";
import { migration as m0246 } from "@/lib/db/migrations/tenant/0246-rainfall";
import { migration as m0247 } from "@/lib/db/migrations/tenant/0247-farm-tasks";
import { migration as m0248 } from "@/lib/db/migrations/tenant/0248-farm-map-assets";
import { migration as m0251 } from "@/lib/db/migrations/tenant/0251-access-emails";
import { migration as m0252 } from "@/lib/db/migrations/tenant/0252-mob-event-reversals";
import { migration as m0253 } from "@/lib/db/migrations/tenant/0253-vegetation-imagery";
import { migration as m0257 } from "@/lib/db/migrations/tenant/0257-metservice-forecast";
import { migration as m0258 } from "@/lib/db/migrations/tenant/0258-metservice-forecast-records";
import { migration as m0259 } from "@/lib/db/migrations/tenant/0259-mob-event-types-animals-and-reversed";
import { migration as m0260 } from "@/lib/db/migrations/tenant/0260-weather-settings-revision";
import { migration as m0261 } from "@/lib/db/migrations/tenant/0261-weather-records-acknowledgement";
import { migration as m0262 } from "@/lib/db/migrations/tenant/0262-cash-flow-layouts";
import { migration as m0263 } from "@/lib/db/migrations/tenant/0263-custom-reports-more-starts";
import { migration as m0264 } from "@/lib/db/migrations/tenant/0264-equity-layouts";
import { migration as m0265 } from "@/lib/db/migrations/tenant/0265-sales-when-sent";
import { migration as m0266 } from "@/lib/db/migrations/tenant/0266-bank-redo-batches";
import { migration as m0267 } from "@/lib/db/migrations/tenant/0267-annual-statement-documents";
import { migration as m0268 } from "@/lib/db/migrations/tenant/0268-ai-journal-void-settings";
import { migration as m0269 } from "@/lib/db/migrations/tenant/0269-account-reporting-names";
import { migration as m0270 } from "@/lib/db/migrations/tenant/0270-apply-when-sent";
import { migration as m0271 } from "@/lib/db/migrations/tenant/0271-bank-transaction-recodes";
import { migration as m0272 } from "@/lib/db/migrations/tenant/0272-sales-platform-stock-items";
import { migration as m0273 } from "@/lib/db/migrations/tenant/0273-sales-platform-gift-cards";
import { migration as m0274 } from "@/lib/db/migrations/tenant/0274-gateway-settlements";
import { migration as m0275 } from "@/lib/db/migrations/tenant/0275-sales-platform-gift-card-items";
import { migration as m0276 } from "@/lib/db/migrations/tenant/0276-vegetation-cover-models";
import { migration as m0277 } from "@/lib/db/migrations/tenant/0277-farm-weather-days";
import { migration as m0278 } from "@/lib/db/migrations/tenant/0278-livestock-bobby-calves";
import { migration as m0279 } from "@/lib/db/migrations/tenant/0279-livestock-pigs";
import { migration as m0280 } from "@/lib/db/migrations/tenant/0280-livestock-associated-purchases";
import { migration as m0281 } from "@/lib/db/migrations/tenant/0281-livestock-bobby-calves-sold";
import { migration as m0282 } from "@/lib/db/migrations/tenant/0282-annual-statement-drafts";
import { migration as m0283 } from "@/lib/db/migrations/tenant/0283-ai-action-approvals";
import { migration as m0284 } from "@/lib/db/migrations/tenant/0284-organisation-directory";
import { migration as m0285 } from "@/lib/db/migrations/tenant/0285-analytics-connection-extra-functions";
import { migration as m0286 } from "@/lib/db/migrations/tenant/0286-vegetation-settings-row";
import { migration as m0287 } from "@/lib/db/migrations/tenant/0287-analytics-merchant-center";
import { migration as m0288 } from "@/lib/db/migrations/tenant/0288-sales-platform-order-closed-at";
import { migration as m0289 } from "@/lib/db/migrations/tenant/0289-analytics-business-profile-google-ads";
import { migration as m0290 } from "@/lib/db/migrations/tenant/0290-payroll-add-on";
import { migration as m0291 } from "@/lib/db/migrations/tenant/0291-sales-platform-order-history";
import { migration as m0292 } from "@/lib/db/migrations/tenant/0292-farm-chat";
import { migration as m0293 } from "@/lib/db/migrations/tenant/0293-farm-chat-voice";

/**
 * Migrations applied to every organisation's own database. Each organisation
 * is a separate PostgreSQL database, so these tables never contain another
 * organisation's rows and can be backed up, restored or moved on their own.
 *
 * Integrity rules the database enforces itself (not just the app):
 * - every journal balances, checked at commit (deferred constraint triggers);
 * - posted history (journals, lines, stock movements, revaluations, audit) is
 *   append-only; corrections are new rows;
 * - stock on hand and carrying value can't go negative;
 * - contacts are archived, never deleted, and active contact names are unique
 *   ignoring case;
 * - approved sales invoices and their lines can't be edited or deleted, only
 *   voided, and invoice numbers only move forward one at a time;
 * - customer payments can't be edited or deleted, only voided once; they're
 *   only against approved invoices, the part that pays the invoice never
 *   takes it past its total (the rest is an overpayment), and an invoice
 *   with active payments can't be voided;
 * - approved bills and their lines can't be edited or deleted, only voided,
 *   and a supplier can't have two bills that aren't voided with the same
 *   invoice number, ignoring case and spaces;
 * - supplier payments can't be edited or deleted, only voided once; they're
 *   only against approved bills, never add up to more than the bill's total,
 *   and a bill with active payments can't be voided;
 * - approved sales credit notes and their lines can't be edited or deleted,
 *   only voided (not while credit is applied or refunded), and credit note
 *   numbers only move forward one at a time;
 * - credit note applications can only be removed once and refunds only
 *   voided once; an invoice's active payments and applied credit never add
 *   up to more than its total, a credit note's applied and refunded credit
 *   never more than its total, and an invoice with credit applied can't be
 *   voided;
 * - approved supplier credit notes and their lines can't be edited or
 *   deleted, only voided (not while credit is applied or refunded), and a
 *   supplier can't have two that aren't voided with the same number,
 *   ignoring case and spaces;
 * - supplier credit note applications can only be removed once and refunds
 *   only voided once; a bill's active payments and applied credit never add
 *   up to more than its total, a supplier credit note's applied and refunded
 *   credit never more than its total, and a bill with credit applied can't
 *   be voided;
 * - an overpayment is exactly what a payment paid beyond its invoice's
 *   amount due; overpayment applications can only be removed once and
 *   refunds only voided once; applied and refunded overpayment never adds up
 *   to more than the overpayment, a payment whose overpayment is used can't
 *   be voided, and an invoice with overpayment credit applied can't be
 *   voided;
 * - statement lines on bank and credit card accounts can't be changed or
 *   deleted, only reconciled, excluded or deleted with their import; an
 *   active reconciliation adds up to its line and only uses journal lines on
 *   the line's account, each once; a reconciled journal can't be reversed;
 *   bank transactions and transfers can't be edited or deleted, only voided
 *   once;
 * - filed GST returns, their adjustments and their snapshot lines can't be
 *   changed, deleted or truncated, their boxes add up (checked at commit),
 *   and no two filed returns cover the same day.
 */
/**
 * Each migration is its own file in ./tenant/ (decision 1682). This list is
 * the order they run in, which isn't always number order: branches merged at
 * different times. Add a new migration as a new file, then add it to the end
 * of this list. Never edit a released one: tests/unit/migration-files.test.ts
 * checks each against the checksum it was released with.
 */
export const tenantMigrations: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
  m0038,
  m0039,
  m0040,
  m0041,
  m0042,
  m0043,
  m0044,
  m0045,
  m0046,
  m0047,
  m0048,
  m0049,
  m0050,
  m0051,
  m0052,
  m0053,
  m0057,
  m0055,
  m0056,
  m0059,
  m0060,
  m0058,
  m0062,
  m0061,
  m0063,
  m0064,
  m0065,
  m0066,
  m0067,
  m0068,
  m0069,
  m0070,
  m0071,
  m0072,
  m0073,
  m0074,
  m0075,
  m0076,
  m0077,
  m0078,
  m0079,
  m0080,
  m0081,
  m0082,
  m0083,
  m0084,
  m0085,
  m0086,
  m0087,
  m0088,
  m0089,
  m0090,
  m0091,
  m0092,
  m0093,
  m0094,
  m0095,
  m0096,
  m0097,
  m0098,
  m0099,
  m0100,
  m0101,
  m0102,
  m0103,
  m0104,
  m0105,
  m0106,
  m0107,
  m0108,
  m0109,
  m0110,
  m0111,
  m0112,
  m0113,
  m0114,
  m0115,
  m0116,
  m0117,
  m0118,
  m0119,
  m0120,
  m0121,
  m0122,
  m0123,
  m0124,
  m0125,
  m0126,
  m0127,
  m0128,
  m0129,
  m0130,
  m0131,
  m0132,
  m0133,
  m0134,
  m0135,
  m0136,
  m0137,
  m0138,
  m0139,
  m0140,
  m0141,
  m0142,
  m0143,
  m0144,
  m0145,
  m0146,
  m0147,
  m0148,
  m0149,
  m0150,
  m0151,
  m0152,
  m0153,
  m0154,
  m0155,
  m0156,
  m0157,
  m0158,
  m0159,
  m0160,
  m0161,
  m0162,
  m0163,
  m0164,
  m0165,
  m0166,
  m0167,
  m0168,
  m0169,
  m0170,
  m0171,
  m0172,
  m0174,
  m0175,
  m0173,
  m0176,
  m0177,
  m0180,
  m0179,
  m0182,
  m0183,
  m0178,
  m0184,
  m0185,
  m0186,
  m0187,
  m0188,
  m0189,
  m0190,
  m0191,
  m0193,
  m0197,
  m0199,
  m0200,
  m0201,
  m0202,
  m0205,
  m0207,
  m0209,
  m0210,
  m0211,
  m0212,
  m0213,
  m0214,
  m0215,
  m0216,
  m0217,
  m0218,
  m0219,
  m0220,
  m0221,
  m0222,
  m0223,
  m0225,
  m0226,
  m0227,
  m0228,
  m0229,
  m0230,
  m0233,
  m0234,
  m0235,
  m0236,
  m0237,
  m0238,
  m0239,
  m0240,
  m0246,
  m0247,
  m0248,
  m0251,
  m0252,
  m0253,
  m0257,
  m0258,
  m0259,
  m0260,
  m0261,
  m0262,
  m0263,
  m0264,
  m0265,
  m0266,
  m0267,
  m0268,
  m0269,
  m0270,
  m0271,
  m0272,
  m0273,
  m0274,
  m0275,
  m0276,
  m0277,
  m0278,
  m0279,
  m0280,
  m0281,
  m0282,
  m0283,
  m0284,
  m0285,
  m0286,
  m0287,
  m0288,
  m0289,
  m0290,
  m0291,
  m0292,
  m0293,
];
