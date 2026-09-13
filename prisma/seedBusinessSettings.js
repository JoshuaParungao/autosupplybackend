require("../src/config/env");

const prisma = require("../src/config/prisma");

const GLOBAL_SCOPE_PREFIX = "GLOBAL";

const settings = [
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:quotation.cash_discounted_amount_formula`,
    key: "quotation.cash_discounted_amount_formula",
    category: "BUSINESS_RULE",
    valueType: "STRING",
    value: "quantity * cashDiscountedPrice",
    label: "Quotation Cash Discounted Amount Formula",
    description: "Formula used for item amount in quotation: QTY multiplied by Cash Discounted Price.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:quotation.total_cash_discounted_price_formula`,
    key: "quotation.total_cash_discounted_price_formula",
    category: "BUSINESS_RULE",
    valueType: "STRING",
    value: "sum(itemAmounts)",
    label: "Total Cash Discounted Price Formula",
    description: "Formula used to compute quotation total cash discounted price.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:quotation.suggested_retail_price_basis`,
    key: "quotation.suggested_retail_price_basis",
    category: "BUSINESS_RULE",
    valueType: "NUMBER",
    value: 0.96,
    label: "Suggested Retail Price Basis",
    description: "Client formula: Suggested Retail Price = Total Cash Discounted Price / 0.96.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:quotation.regular_price_basis`,
    key: "quotation.regular_price_basis",
    category: "BUSINESS_RULE",
    valueType: "NUMBER",
    value: 0.875,
    label: "Regular Price Basis",
    description: "Client formula: Regular Price = Total Cash Discounted Price / 0.875.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:installment.term_basis`,
    key: "installment.term_basis",
    category: "BUSINESS_RULE",
    valueType: "JSON",
    value: {
      STRAIGHT: 0.96,
      MONTH_3: 0.96,
      MONTH_6: 0.935,
      MONTH_9: 0.905,
      MONTH_12: 0.875,
      MONTH_18: 0.815,
      MONTH_24: 0.755,
    },
    label: "Installment Term Basis",
    description: "Client installment basis values used for credit-card or installment computations.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:installment.balance_formula`,
    key: "installment.balance_formula",
    category: "BUSINESS_RULE",
    valueType: "STRING",
    value: "(cashPromoTotalAmount - cashDownpayment) / termBasis",
    label: "Installment Balance Formula",
    description: "Client formula for installment balance after cash downpayment.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.major_parts_months`,
    key: "warranty.major_parts_months",
    category: "BUSINESS_RULE",
    valueType: "NUMBER",
    value: 12,
    label: "Major Parts Warranty Months",
    description: "Default warranty duration for major parts.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.accessories_days`,
    key: "warranty.accessories_days",
    category: "BUSINESS_RULE",
    valueType: "NUMBER",
    value: 30,
    label: "Accessories Warranty Days",
    description: "Default warranty duration for accessories.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.outright_replacement_days`,
    key: "warranty.outright_replacement_days",
    category: "BUSINESS_RULE",
    valueType: "NUMBER",
    value: 7,
    label: "Outright Replacement Days",
    description: "Default outright replacement period except excluded products such as printers.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:cash_box.require_handover_confirmation`,
    key: "cash_box.require_handover_confirmation",
    category: "OPERATION",
    valueType: "BOOLEAN",
    value: true,
    label: "Require Cash Handover Confirmation",
    description: "Requires cash custodian confirmation before cash is considered received.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:cash_box.default_payment_status`,
    key: "cash_box.default_payment_status",
    category: "OPERATION",
    valueType: "STRING",
    value: "PENDING_HANDOVER",
    label: "Default Payment Status",
    description: "Default cash status after cashier or technician records a payment.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:receipt.business_name`,
    key: "receipt.business_name",
    category: "DOCUMENT",
    valueType: "STRING",
    value: "Auto Supply",
    label: "Receipt Business Name",
    description: "Default business name shown on receipts and printable documents.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:receipt.default_footer_notes`,
    key: "receipt.default_footer_notes",
    category: "DOCUMENT",
    valueType: "ARRAY",
    value: [
      "Thank you for your purchase.",
      "Please keep this receipt for warranty purposes.",
    ],
    label: "Receipt Default Footer Notes",
    description: "Default footer notes shown on receipts.",
  },
  {
    scopeKey: `${GLOBAL_SCOPE_PREFIX}:system.allow_branch_specific_settings`,
    key: "system.allow_branch_specific_settings",
    category: "SYSTEM_ADMIN",
    valueType: "BOOLEAN",
    value: true,
    label: "Allow Branch Specific Settings",
    description: "Allows future branch-level overrides for selected settings.",
  },
];

const seedBusinessSettings = async () => {
  console.log("Seeding default business settings...");

  for (const setting of settings) {
    await prisma.businessSetting.upsert({
      where: {
        scopeKey: setting.scopeKey,
      },
      update: {
        key: setting.key,
        category: setting.category,
        valueType: setting.valueType,
        value: setting.value,
        label: setting.label,
        description: setting.description,
        isEditable: true,
        isActive: true,
      },
      create: {
        scopeKey: setting.scopeKey,
        key: setting.key,
        category: setting.category,
        valueType: setting.valueType,
        value: setting.value,
        label: setting.label,
        description: setting.description,
        isEditable: true,
        isActive: true,
      },
    });

    console.log(`Seeded: ${setting.scopeKey}`);
  }

  const totalSettings = await prisma.businessSetting.count();

  console.log(`Done. Total business settings: ${totalSettings}`);
};

seedBusinessSettings()
  .catch((error) => {
    console.error("Business settings seeding failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
