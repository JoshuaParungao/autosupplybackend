require("dotenv").config();
const bcrypt = require("bcryptjs");
const prisma = require("../src/config/prisma");

async function seedAutoSupply() {
  console.log("=== STARTING AUTO SUPPLY BOOTSTRAP SEED (4 BRANCHES) ===");

  // 1. Migrate / Rename existing legacy codes if any
  try {
    await prisma.branch.updateMany({
      where: { code: "MAIN" },
      data: { code: "BRA", name: "Branch A" },
    });
    await prisma.branch.updateMany({
      where: { code: "MAB" },
      data: { code: "BRB", name: "Branch B" },
    });
  } catch (e) {
    // ignore if already done
  }

  // 1. Seed 4 Branches: Branch A, Branch B, Branch C, Branch D
  console.log("\n1. Seeding 4 Branches...");
  const branchConfigs = [
    { code: "BRA", name: "Branch A", address: "Branch A - Highway Commercial Center", contactNo: "0917-001-0001" },
    { code: "BRB", name: "Branch B", address: "Branch B - Downtown Commercial Strip", contactNo: "0917-002-0002" },
    { code: "BRC", name: "Branch C", address: "Branch C - Expressway Interchange", contactNo: "0917-003-0003" },
    { code: "BRD", name: "Branch D", address: "Branch D - Industrial Hub & Fleet Center", contactNo: "0917-004-0004" },
  ];

  const branches = {};
  for (const b of branchConfigs) {
    const saved = await prisma.branch.upsert({
      where: { code: b.code },
      update: { name: b.name, address: b.address, contactNo: b.contactNo, status: "ACTIVE" },
      create: { code: b.code, name: b.name, address: b.address, contactNo: b.contactNo, status: "ACTIVE" },
    });
    branches[b.code] = saved;
    console.log(`- Branch [${b.code}]: ${saved.name} (${saved.id})`);
  }

  // 2. Seed Admin & Staff Users
  console.log("\n2. Seeding Super Owner, Branch Admins, & Tech Users...");
  const defaultPassword = process.env.INITIAL_ADMIN_PASSWORD || "Password123!";
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  const superOwner = await prisma.user.upsert({
    where: { username: "superowner" },
    update: {
      role: "SUPER_OWNER",
      status: "ACTIVE",
      passwordHash,
    },
    create: {
      username: "superowner",
      firstName: "Super",
      lastName: "Owner",
      fullName: "Auto Supply Owner",
      employeeCode: "EMP-0001",
      role: "SUPER_OWNER",
      status: "ACTIVE",
      passwordHash,
    },
  });
  console.log(`- Super Owner: ${superOwner.username} (All branches access)`);

  const branchAdmins = [
    { username: "admin_a", code: "BRA", name: "Admin Branch A", emp: "EMP-1001" },
    { username: "admin_b", code: "BRB", name: "Admin Branch B", emp: "EMP-1002" },
    { username: "admin_c", code: "BRC", name: "Admin Branch C", emp: "EMP-1003" },
    { username: "admin_d", code: "BRD", name: "Admin Branch D", emp: "EMP-1004" },
    { username: "mainadmin", code: "BRA", name: "Main Admin", emp: "EMP-0002" },
  ];

  for (const adm of branchAdmins) {
    const branch = branches[adm.code];
    await prisma.user.upsert({
      where: { username: adm.username },
      update: {
        role: "ADMIN",
        status: "ACTIVE",
        branchId: branch.id,
        passwordHash,
      },
      create: {
        username: adm.username,
        email: `${adm.username}@autosupply.local`,
        firstName: adm.name.split(" ")[0],
        lastName: adm.name.split(" ").slice(1).join(" ") || "Admin",
        fullName: adm.name,
        employeeCode: adm.emp,
        role: "ADMIN",
        status: "ACTIVE",
        branchId: branch.id,
        passwordHash,
      },
    });
    console.log(`- Admin: ${adm.username} for ${branch.name}`);
  }

  const mainTech = await prisma.user.upsert({
    where: { username: "autotech" },
    update: {
      role: "TECHNICIAN",
      status: "ACTIVE",
      branchId: branches["BRA"].id,
      passwordHash,
    },
    create: {
      username: "autotech",
      email: "mechanic@autosupply.local",
      firstName: "Lead",
      lastName: "Mechanic",
      fullName: "Lead Auto Mechanic",
      employeeCode: "EMP-0003",
      role: "TECHNICIAN",
      status: "ACTIVE",
      branchId: branches["BRA"].id,
      passwordHash,
    },
  });
  console.log(`- Lead Auto Mechanic: ${mainTech.username}`);

  // 3. Seed Business Settings
  console.log("\n3. Seeding Business Settings...");
  const GLOBAL_SCOPE_PREFIX = "GLOBAL";
  const settings = [
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
        "Thank you for choosing Auto Supply!",
        "Specialized in Genuine & OEM Automotive Parts and Services.",
        "Please keep this receipt for warranty and parts exchange validation.",
      ],
      label: "Receipt Default Footer Notes",
      description: "Default footer notes shown on receipts.",
    },
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
      description: "Suggested Retail Price calculation basis.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:quotation.regular_price_basis`,
      key: "quotation.regular_price_basis",
      category: "BUSINESS_RULE",
      valueType: "NUMBER",
      value: 0.875,
      label: "Regular Price Basis",
      description: "Regular Price calculation basis.",
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
      description: "Installment basis values used for credit-card or financing computations.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:installment.balance_formula`,
      key: "installment.balance_formula",
      category: "BUSINESS_RULE",
      valueType: "STRING",
      value: "(cashPromoTotalAmount - cashDownpayment) / termBasis",
      label: "Installment Balance Formula",
      description: "Installment balance after cash downpayment.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.major_parts_months`,
      key: "warranty.major_parts_months",
      category: "BUSINESS_RULE",
      valueType: "NUMBER",
      value: 6,
      label: "Major Parts Warranty Months",
      description: "Default warranty duration for major automotive assemblies/parts.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.accessories_days`,
      key: "warranty.accessories_days",
      category: "BUSINESS_RULE",
      valueType: "NUMBER",
      value: 30,
      label: "Accessories Warranty Days",
      description: "Default warranty duration for accessories and wear-and-tear components.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:warranty.outright_replacement_days`,
      key: "warranty.outright_replacement_days",
      category: "BUSINESS_RULE",
      valueType: "NUMBER",
      value: 7,
      label: "Outright Replacement Days",
      description: "Default outright replacement period for factory defects.",
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
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:system.allow_branch_specific_settings`,
      key: "system.allow_branch_specific_settings",
      category: "SYSTEM_ADMIN",
      valueType: "BOOLEAN",
      value: true,
      label: "Allow Branch Specific Settings",
      description: "Allows branch-level overrides for selected settings.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:price.tier_labels`,
      key: "price.tier_labels",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        1: "SRP / Retail",
        2: "Wholesale / Fleet",
        3: "Shop / Mechanic Rate",
        4: "Distributor / VIP",
        5: "Special Promo",
      },
      label: "Price Tier Labels",
      description: "Display names for auto parts pricing tiers.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:payment.methods`,
      key: "payment.methods",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        cash: true,
        gcash: true,
        bankTransfer: true,
        cardTerminal: true,
        cheque: true,
        creditInstallment: true,
        mixedPayment: true,
        requiredFields: {
          referenceNumber: true,
          cardApprovalCode: true,
          chequeNumber: true,
          bankName: true,
          remarks: false,
        },
      },
      label: "Payment Methods",
      description: "Accepted payment methods and required payment details for POS and service jobs.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:document.numbering`,
      key: "document.numbering",
      category: "DOCUMENT",
      valueType: "JSON",
      value: {
        receipt: { label: "Receipt", prefix: "RCPT", format: "RCPT-{BRANCH}-{YYYYMMDD}-{SEQUENCE}" },
        quotation: { label: "Quotation", prefix: "QT", format: "QT-{BRANCH}-{YYYYMMDD}-{SEQUENCE}" },
        serviceJob: { label: "Service Job / Job Order", prefix: "JO", format: "JO-{BRANCH}-{YYYYMMDD}-{SEQUENCE}" },
        servicePayment: { label: "Service Payment", prefix: "JOPAY", format: "JOPAY-{BRANCH}-{YYYYMMDD}-{SEQUENCE}" },
        warrantyClaim: { label: "Warranty Claim", prefix: "WTY", format: "WTY-{BRANCH}-{YYYYMMDD}-{SEQUENCE}" },
        stockTransfer: { label: "Stock Transfer", prefix: "TR", format: "TR-{BRANCH}-{SEQUENCE}" },
        purchaseOrder: { label: "Purchase Order", prefix: "PO", format: "PO-{BRANCH}-{SEQUENCE}" },
        purchaseReceiving: { label: "Purchase Receiving", prefix: "REC", format: "REC-{BRANCH}-{SEQUENCE}" },
      },
      label: "Document Numbering",
      description: "Document numbering formats for Auto Supply.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:discount.rules`,
      key: "discount.rules",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        discountMode: "AMOUNT_ONLY",
        allowLineItemDiscount: true,
        allowPercentageDiscount: false,
        requireRemarks: false,
        requireOwnerApproval: false,
      },
      label: "Discount Rules",
      description: "Discount rules shown in POS and quotations.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:service.rules`,
      key: "service.rules",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        requireCustomer: false,
        requireTechnicianAssignment: true,
        requireFinalChargeOnCompletion: true,
        requireCancellationReason: true,
        allowPaymentOnlyWhenCompleted: true,
        requireExactPaymentAmount: true,
      },
      label: "Service Rules",
      description: "Job order & auto mechanical service safeguards.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:inventory.rules`,
      key: "inventory.rules",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        blockNegativeStock: true,
        useItemMinimumStock: true,
        useItemReorderLevel: true,
        requireAdjustmentRemarks: true,
        requireOwnerApprovalForAdjustment: false,
        showLowStockAlerts: true,
      },
      label: "Inventory Rules",
      description: "Inventory safeguards for auto supply warehouse and retail shelves.",
    },
    {
      scopeKey: `${GLOBAL_SCOPE_PREFIX}:incentive.rules`,
      key: "incentive.rules",
      category: "OPERATION",
      valueType: "JSON",
      value: {
        enableItemIncentives: true,
        enableServiceIncentives: true,
        defaultItemIncentivePercent: 0,
        defaultServiceIncentivePercent: 0,
        staffCanViewOwnIncentives: true,
        ownerCanViewAllIncentives: true,
        requireOwnerApprovalBeforePayout: true,
      },
      label: "Incentive Rules",
      description: "Mechanic and parts specialist commission rules.",
    },
  ];

  for (const s of settings) {
    await prisma.businessSetting.upsert({
      where: { scopeKey: s.scopeKey },
      update: {
        key: s.key,
        category: s.category,
        valueType: s.valueType,
        value: s.value,
        label: s.label,
        description: s.description,
        isEditable: true,
        isActive: true,
      },
      create: {
        scopeKey: s.scopeKey,
        key: s.key,
        category: s.category,
        valueType: s.valueType,
        value: s.value,
        label: s.label,
        description: s.description,
        isEditable: true,
        isActive: true,
      },
    });
  }
  console.log(`- Upserted ${settings.length} Business Settings.`);

  // 4. Seed Cash Boxes for all 4 Branches
  console.log("\n4. Seeding Cash Boxes for all 4 Branches...");
  for (const code of Object.keys(branches)) {
    const branch = branches[code];
    const boxCode = `CASHBOX-${branch.code}`;
    const existing = await prisma.cashBox.findFirst({
      where: { branchId: branch.id, boxCode },
    });
    if (!existing) {
      await prisma.cashBox.create({
        data: {
          boxCode,
          name: `${branch.name} Cash Drawer`,
          status: "ACTIVE",
          currentBalance: "0.00",
          remarks: `Default cash drawer for ${branch.name}.`,
          branchId: branch.id,
        },
      });
      console.log(`- Created cash box ${boxCode} for ${branch.name}`);
    }
  }

  // 5. Seed Units of Measure
  console.log("\n5. Seeding Units of Measure...");
  const unitsData = [
    { unitCode: "PC", name: "Piece", description: "Individual part or piece" },
    { unitCode: "PCS", name: "Pieces", description: "Multiple pieces" },
    { unitCode: "SET", name: "Set", description: "Complete set (brake pads, gasket sets, clutch sets)" },
    { unitCode: "PAIR", name: "Pair", description: "Pair of items (shock absorbers, wipers)" },
    { unitCode: "BOX", name: "Box", description: "Box of components (spark plugs 4-pack/10-pack)" },
    { unitCode: "BTL", name: "Bottle", description: "Bottle container (oil additives, brake fluid)" },
    { unitCode: "LTR", name: "Liter", description: "Liter container (1L, 4L motor oil)" },
    { unitCode: "CAN", name: "Can", description: "Can container (brake cleaner, spray lube)" },
    { unitCode: "KIT", name: "Kit", description: "Rebuild / overhaul kit" },
    { unitCode: "ROLL", name: "Roll", description: "Tape, electrical wire, or hose roll" },
  ];

  const unitMap = {};
  for (const u of unitsData) {
    const created = await prisma.unit.upsert({
      where: { unitCode: u.unitCode },
      update: { name: u.name, description: u.description, status: "ACTIVE", updatedById: superOwner.id },
      create: { unitCode: u.unitCode, name: u.name, description: u.description, status: "ACTIVE", createdById: superOwner.id, updatedById: superOwner.id },
    });
    unitMap[u.unitCode] = created.id;
  }
  console.log(`- Seeded ${unitsData.length} Units of Measure.`);

  // 6. Categories Definition
  const autoCategories = [
    {
      categoryCode: "CAT-FLUIDS",
      name: "Fluids & Lubricants",
      description: "Engine oil, transmission fluids, coolants, brake fluids, and greases",
      subcategories: [
        {
          categoryCode: "CAT-FLD-ENG",
          name: "Engine Motor Oil",
          description: "Fully synthetic, semi-synthetic, and mineral engine oils",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Shell", "Motul", "Mobil 1", "Castrol", "Petron", "Caltex Havoline", "Toyota Genuine"] },
            { name: "Viscosity Grade", type: "text", required: true, suggestions: ["0W-20", "5W-30", "5W-40", "10W-30", "10W-40", "15W-40", "20W-50"] },
            { name: "Oil Type", type: "text", required: true, suggestions: ["Fully Synthetic", "Semi-Synthetic", "Mineral / Conventional"] },
            { name: "Engine Type", type: "text", required: true, suggestions: ["Gasoline", "Diesel", "Universal / Dual"] },
            { name: "Volume", type: "text", required: true, suggestions: ["1 Liter", "4 Liters", "1 Gallon", "18 Liters Pail"] },
          ],
        },
        {
          categoryCode: "CAT-FLD-ATF",
          name: "Transmission & Gear Fluids",
          description: "ATF, CVTF, and manual transmission gear oils",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Toyota Genuine", "Aisin", "Motul", "Castrol", "Idemitsu", "Petron"] },
            { name: "Fluid Type", type: "text", required: true, suggestions: ["ATF WS", "ATF T-IV", "CVTF", "Gear Oil 75W-90", "Gear Oil 80W-90"] },
            { name: "Volume", type: "text", required: true, suggestions: ["1 Liter", "4 Liters"] },
          ],
        },
        {
          categoryCode: "CAT-FLD-COOL",
          name: "Coolants & Chemicals",
          description: "Radiator coolants, brake cleaner, and penetrating sprays",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Prestone", "Toyota Long Life", "WD-40", "Bosch", "Aisin"] },
            { name: "Type", type: "text", required: true, suggestions: ["Pre-diluted 50/50 Coolant", "Concentrated Coolant", "Carb Cleaner", "Brake Cleaner", "Penetrating Spray"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-FILTERS",
      name: "Filters",
      description: "Oil, air, cabin, and fuel filters for all vehicle makes",
      subcategories: [
        {
          categoryCode: "CAT-FLT-OIL",
          name: "Oil Filters",
          description: "Spin-on and cartridge engine oil filters",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Bosch", "Vic", "Denso", "Mann-Filter", "Toyota Genuine", "Baldwin"] },
            { name: "Part Number / Code", type: "text", required: true, suggestions: ["C-110", "C-111", "C-113", "C-224", "C-307", "O-117"] },
            { name: "Compatible Make", type: "text", required: true, suggestions: ["Toyota", "Mitsubishi", "Honda", "Nissan", "Ford", "Isuzu", "Hyundai"] },
          ],
        },
        {
          categoryCode: "CAT-FLT-AIR",
          name: "Air Filters",
          description: "Engine intake air filters",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Vic", "Bosch", "Denso", "K&N", "Fleetmax"] },
            { name: "Compatible Vehicle", type: "text", required: true, suggestions: ["Vios / Yaris", "Innova / Fortuner / Hilux", "Montero Sport / Strada", "Civic", "Mirage"] },
          ],
        },
        {
          categoryCode: "CAT-FLT-CAB",
          name: "Cabin Filters",
          description: "Aircon cabin filters / pollen filters",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Vic", "Bosch", "Fleetmax", "Denso"] },
            { name: "Filter Type", type: "text", required: true, suggestions: ["Standard Particle", "Activated Carbon"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-BRAKES",
      name: "Braking System",
      description: "Brake pads, brake shoes, rotors, drums, and hydraulic components",
      subcategories: [
        {
          categoryCode: "CAT-BRK-PAD",
          name: "Brake Pads",
          description: "Front and rear disc brake pads",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Akebono", "Bendix", "Brembo", "Advics", "Nisshinbo", "Hi-Q"] },
            { name: "Material", type: "text", required: true, suggestions: ["Ceramic", "Semi-Metallic", "Organic (NAO)"] },
            { name: "Axle", type: "text", required: true, suggestions: ["Front Axle", "Rear Axle"] },
            { name: "Vehicle Application", type: "text", required: true, suggestions: ["Toyota Vios", "Toyota Innova / Fortuner", "Mitsubishi Montero / Strada", "Honda City / Civic"] },
          ],
        },
        {
          categoryCode: "CAT-BRK-ROT",
          name: "Brake Rotors & Drums",
          description: "Brake discs and rear drums",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Brembo", "Runstop", "TRW", "Advics"] },
            { name: "Type", type: "text", required: true, suggestions: ["Plain Solid", "Slotted / Drilled", "Ventilated"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-SUSPENSION",
      name: "Suspension & Steering",
      description: "Shock absorbers, struts, control arms, tie rods, and bushings",
      subcategories: [
        {
          categoryCode: "CAT-SUS-SHK",
          name: "Shock Absorbers & Struts",
          description: "Front struts and rear shock absorbers",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["KYB (Kayaba)", "Monroe", "Tokico", "Profender", "Old Man Emu"] },
            { name: "Position", type: "text", required: true, suggestions: ["Front Left", "Front Right", "Rear Left/Right Pair"] },
            { name: "Type", type: "text", required: true, suggestions: ["Gas Charged (Excel-G)", "Oil / Hydraulic", "Heavy Duty"] },
          ],
        },
        {
          categoryCode: "CAT-SUS-LNK",
          name: "Steering & Suspension Links",
          description: "Tie rod ends, rack ends, stabilizer links, and ball joints",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["555 (Three Five)", "CTR", "TRW", "Federal Mogul"] },
            { name: "Component", type: "text", required: true, suggestions: ["Tie Rod End", "Rack End", "Stabilizer Link", "Lower Ball Joint", "Upper Ball Joint"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-ELECTRICAL",
      name: "Electrical & Lighting",
      description: "Car batteries, spark plugs, alternators, and headlight bulbs",
      subcategories: [
        {
          categoryCode: "CAT-ELC-BAT",
          name: "Car Batteries",
          description: "Maintenance-free (MF) and AGM automotive batteries",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Motolite", "Amaron", "GS Yuasa", "Panasonic", "Outlast"] },
            { name: "Battery Size / Model", type: "text", required: true, suggestions: ["1SNF (NS40ZL)", "2SMF (NS60LS)", "3SMF (N70)", "DIN55", "DIN66", "DIN84"] },
            { name: "Warranty Months", type: "text", required: true, suggestions: ["12 Months", "15 Months", "21 Months", "24 Months"] },
          ],
        },
        {
          categoryCode: "CAT-ELC-SPK",
          name: "Spark Plugs",
          description: "Iridium, platinum, and nickel spark plugs",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["NGK", "Denso", "Bosch", "Champion"] },
            { name: "Type", type: "text", required: true, suggestions: ["Laser Iridium", "Iridium TT", "Platinum", "Standard Copper"] },
            { name: "Heat Range / Model", type: "text", required: true, suggestions: ["LFR6C-11", "ILKAR7B11", "SC20HR11", "BKR6E-11"] },
          ],
        },
        {
          categoryCode: "CAT-ELC-BLB",
          name: "Bulbs & Lighting",
          description: "Headlight bulbs, LED upgrades, and signal lamps",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Osram", "Philips", "Bosch", "Novsight"] },
            { name: "Socket Type", type: "text", required: true, suggestions: ["H4", "H11", "H7", "HB3 / 9005", "HB4 / 9006", "T10"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-TIRES",
      name: "Tires & Accessories",
      description: "Passenger car and SUV tires, valves, and wheel accessories",
      subcategories: [
        {
          categoryCode: "CAT-TIR-TIRE",
          name: "Tires",
          description: "Radial tires for passenger cars, MPVs, and pick-ups",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Michelin", "Bridgestone", "Yokohama", "Dunlop", "Goodyear", "Sailun", "Maxxis"] },
            { name: "Size", type: "text", required: true, suggestions: ["175/65 R14", "185/60 R15", "195/65 R15", "205/55 R16", "215/60 R16", "265/65 R17", "265/60 R18"] },
            { name: "Pattern / Series", type: "text", required: true, suggestions: ["Comfort / Touring", "All-Terrain (A/T)", "Highway Terrain (H/T)", "Sport"] },
          ],
        },
      ],
    },
    {
      categoryCode: "CAT-ACCESSORIES",
      name: "Auto Care & Accessories",
      description: "Wiper blades, car shampoos, horns, and emergency gear",
      subcategories: [
        {
          categoryCode: "CAT-ACC-WIP",
          name: "Wiper Blades",
          description: "Silicone and conventional frame windshield wipers",
          attributeSchema: [
            { name: "Brand", type: "text", required: true, suggestions: ["Bosch Advantage", "Bosch Clear Advantage", "Denso", "NWB", "Michelin"] },
            { name: "Length", type: "text", required: true, suggestions: ["14 inch", "16 inch", "18 inch", "20 inch", "22 inch", "24 inch", "26 inch"] },
            { name: "Blade Type", type: "text", required: true, suggestions: ["Hook Slot Frame", "Frameless Aerodynamic Beam", "Hybrid"] },
          ],
        },
      ],
    },
  ];

  // Starter Items Template
  const starterItems = [
    {
      itemCode: "OIL-SH-HLX-5W40-4L",
      barcode: "480001000101",
      itemName: "Shell Helix Ultra 5W-40 Fully Synthetic Engine Oil (4 Liters)",
      categoryCode: "CAT-FLD-ENG",
      unitCode: "LTR",
      costPrice: 1650.00,
      price1: 2200.00,
      price2: 2100.00,
      price3: 2000.00,
      price4: 1950.00,
      price5: 1900.00,
      isSerialized: false,
      attributes: { Brand: "Shell", "Viscosity Grade": "5W-40", "Oil Type": "Fully Synthetic", "Engine Type": "Gasoline", Volume: "4 Liters" },
    },
    {
      itemCode: "OIL-MTL-HT100-5W30-4L",
      barcode: "480001000102",
      itemName: "Motul H-Tech 100 Plus 5W-30 Synthetic Engine Oil (4 Liters)",
      categoryCode: "CAT-FLD-ENG",
      unitCode: "LTR",
      costPrice: 1750.00,
      price1: 2350.00,
      price2: 2250.00,
      price3: 2150.00,
      price4: 2100.00,
      price5: 2050.00,
      isSerialized: false,
      attributes: { Brand: "Motul", "Viscosity Grade": "5W-30", "Oil Type": "Fully Synthetic", "Engine Type": "Gasoline", Volume: "4 Liters" },
    },
    {
      itemCode: "FLT-VIC-C110",
      barcode: "480002000201",
      itemName: "VIC Oil Filter C-110 (Toyota Vios / Altis / Yaris)",
      categoryCode: "CAT-FLT-OIL",
      unitCode: "PC",
      costPrice: 180.00,
      price1: 280.00,
      price2: 260.00,
      price3: 250.00,
      price4: 240.00,
      price5: 230.00,
      isSerialized: false,
      attributes: { Brand: "Vic", "Part Number / Code": "C-110", "Compatible Make": "Toyota" },
    },
    {
      itemCode: "FLT-VIC-C111",
      barcode: "480002000202",
      itemName: "VIC Oil Filter C-111 (Toyota Innova / Fortuner / Hilux 2KD/1GD)",
      categoryCode: "CAT-FLT-OIL",
      unitCode: "PC",
      costPrice: 240.00,
      price1: 380.00,
      price2: 350.00,
      price3: 330.00,
      price4: 310.00,
      price5: 300.00,
      isSerialized: false,
      attributes: { Brand: "Vic", "Part Number / Code": "C-111", "Compatible Make": "Toyota" },
    },
    {
      itemCode: "BRK-AKE-VIOS-F",
      barcode: "480003000301",
      itemName: "Akebono Ceramic Front Brake Pads (Toyota Vios 2014-2022)",
      categoryCode: "CAT-BRK-PAD",
      unitCode: "SET",
      costPrice: 1200.00,
      price1: 1750.00,
      price2: 1650.00,
      price3: 1600.00,
      price4: 1550.00,
      price5: 1500.00,
      isSerialized: false,
      attributes: { Brand: "Akebono", Material: "Ceramic", Axle: "Front Axle", "Vehicle Application": "Toyota Vios" },
    },
    {
      itemCode: "BRK-BNX-INNO-F",
      barcode: "480003000302",
      itemName: "Bendix General CT Front Brake Pads (Innova / Fortuner / Hilux)",
      categoryCode: "CAT-BRK-PAD",
      unitCode: "SET",
      costPrice: 1350.00,
      price1: 1950.00,
      price2: 1850.00,
      price3: 1800.00,
      price4: 1750.00,
      price5: 1700.00,
      isSerialized: false,
      attributes: { Brand: "Bendix", Material: "Ceramic", Axle: "Front Axle", "Vehicle Application": "Toyota Innova / Fortuner" },
    },
    {
      itemCode: "SPK-NGK-ILKAR7B11",
      barcode: "480004000401",
      itemName: "NGK Laser Iridium Spark Plug ILKAR7B11 (Set of 4)",
      categoryCode: "CAT-ELC-SPK",
      unitCode: "SET",
      costPrice: 1400.00,
      price1: 2000.00,
      price2: 1900.00,
      price3: 1800.00,
      price4: 1750.00,
      price5: 1700.00,
      isSerialized: false,
      attributes: { Brand: "NGK", Type: "Laser Iridium", "Heat Range / Model": "ILKAR7B11" },
    },
    {
      itemCode: "BAT-MTL-GOLD-1SNF",
      barcode: "480005000501",
      itemName: "Motolite Gold 1SNF / NS40ZL Maintenance Free Battery",
      categoryCode: "CAT-ELC-BAT",
      unitCode: "PC",
      costPrice: 3600.00,
      price1: 4550.00,
      price2: 4400.00,
      price3: 4300.00,
      price4: 4200.00,
      price5: 4100.00,
      isSerialized: true,
      attributes: { Brand: "Motolite", "Battery Size / Model": "1SNF (NS40ZL)", "Warranty Months": "21 Months" },
    },
    {
      itemCode: "WIP-BSH-ADV-24",
      barcode: "480006000601",
      itemName: "Bosch Advantage Wiper Blade 24 Inches (Single)",
      categoryCode: "CAT-ACC-WIP",
      unitCode: "PC",
      costPrice: 180.00,
      price1: 290.00,
      price2: 270.00,
      price3: 260.00,
      price4: 250.00,
      price5: 240.00,
      isSerialized: false,
      attributes: { Brand: "Bosch Advantage", Length: "24 inch", "Blade Type": "Hook Slot Frame" },
    },
    {
      itemCode: "WIP-BSH-ADV-14",
      barcode: "480006000602",
      itemName: "Bosch Advantage Wiper Blade 14 Inches (Single)",
      categoryCode: "CAT-ACC-WIP",
      unitCode: "PC",
      costPrice: 150.00,
      price1: 250.00,
      price2: 230.00,
      price3: 220.00,
      price4: 210.00,
      price5: 200.00,
      isSerialized: false,
      attributes: { Brand: "Bosch Advantage", Length: "14 inch", "Blade Type": "Hook Slot Frame" },
    },
  ];

  // 6 & 7 & 8: Seed Categories, Items, and Customers for ALL 4 BRANCHES!
  console.log("\n6. Seeding Categories, Items, and Customers for all 4 Branches...");
  for (const code of Object.keys(branches)) {
    const currentBranch = branches[code];
    console.log(`\n--- Processing ${currentBranch.name} (${currentBranch.code}) ---`);

    const categoryMap = {};
    for (const parent of autoCategories) {
      const parentCat = await prisma.itemCategory.upsert({
        where: {
          branchId_categoryCode: {
            branchId: currentBranch.id,
            categoryCode: parent.categoryCode,
          },
        },
        update: {
          name: parent.name,
          description: parent.description,
          status: "ACTIVE",
          updatedById: superOwner.id,
        },
        create: {
          categoryCode: parent.categoryCode,
          name: parent.name,
          description: parent.description,
          status: "ACTIVE",
          branchId: currentBranch.id,
          createdById: superOwner.id,
          updatedById: superOwner.id,
        },
      });
      categoryMap[parent.categoryCode] = parentCat.id;

      for (const sub of parent.subcategories) {
        const subCat = await prisma.itemCategory.upsert({
          where: {
            branchId_categoryCode: {
              branchId: currentBranch.id,
              categoryCode: sub.categoryCode,
            },
          },
          update: {
            name: sub.name,
            description: sub.description,
            parentId: parentCat.id,
            attributeSchema: sub.attributeSchema,
            status: "ACTIVE",
            updatedById: superOwner.id,
          },
          create: {
            categoryCode: sub.categoryCode,
            name: sub.name,
            description: sub.description,
            parentId: parentCat.id,
            attributeSchema: sub.attributeSchema,
            status: "ACTIVE",
            branchId: currentBranch.id,
            createdById: superOwner.id,
            updatedById: superOwner.id,
          },
        });
        categoryMap[sub.categoryCode] = subCat.id;
      }
    }
    console.log(`- Categories populated for ${currentBranch.name}`);

    // Seed Items for currentBranch
    for (const item of starterItems) {
      const catId = categoryMap[item.categoryCode];
      const uId = unitMap[item.unitCode];

      await prisma.item.upsert({
        where: {
          branchId_itemCode: {
            branchId: currentBranch.id,
            itemCode: item.itemCode,
          },
        },
        update: {
          itemName: item.itemName,
          barcode: item.barcode,
          categoryId: catId,
          unitId: uId,
          costPrice: item.costPrice,
          price1: item.price1,
          price2: item.price2,
          price3: item.price3,
          price4: item.price4,
          price5: item.price5,
          isSerialized: item.isSerialized,
          attributes: item.attributes,
          status: "ACTIVE",
          updatedById: superOwner.id,
        },
        create: {
          branchId: currentBranch.id,
          itemCode: item.itemCode,
          barcode: item.barcode,
          itemName: item.itemName,
          categoryId: catId,
          unitId: uId,
          costPrice: item.costPrice,
          price1: item.price1,
          price2: item.price2,
          price3: item.price3,
          price4: item.price4,
          price5: item.price5,
          isSerialized: item.isSerialized,
          attributes: item.attributes,
          status: "ACTIVE",
          createdById: superOwner.id,
          updatedById: superOwner.id,
        },
      });
    }
    console.log(`- ${starterItems.length} Starter Items populated for ${currentBranch.name}`);

    // Seed Customers for currentBranch
    await prisma.customer.upsert({
      where: {
        branchId_customerCode: {
          branchId: currentBranch.id,
          customerCode: "CUST-WALKIN",
        },
      },
      update: {
        fullName: "Walk-in Customer",
        mobileNumber: "09000000000",
        status: "ACTIVE",
        updatedById: superOwner.id,
      },
      create: {
        customerCode: "CUST-WALKIN",
        fullName: "Walk-in Customer",
        mobileNumber: "09000000000",
        status: "ACTIVE",
        priceTier: 1,
        branchId: currentBranch.id,
        createdById: superOwner.id,
        updatedById: superOwner.id,
      },
    });

    await prisma.customer.upsert({
      where: {
        branchId_customerCode: {
          branchId: currentBranch.id,
          customerCode: "CUST-FLEET01",
        },
      },
      update: {
        fullName: "FastTrans Logistics & Fleet Services",
        companyName: "FastTrans Logistics Inc.",
        mobileNumber: "09171234567",
        address: "123 Expressway Access Road, Pampanga",
        priceTier: 2,
        status: "ACTIVE",
        updatedById: superOwner.id,
      },
      create: {
        customerCode: "CUST-FLEET01",
        fullName: "FastTrans Logistics & Fleet Services",
        companyName: "FastTrans Logistics Inc.",
        mobileNumber: "09171234567",
        address: "123 Expressway Access Road, Pampanga",
        priceTier: 2,
        status: "ACTIVE",
        branchId: currentBranch.id,
        createdById: superOwner.id,
        updatedById: superOwner.id,
      },
    });
    console.log(`- Default Customers populated for ${currentBranch.name}`);
  }

  console.log("\n🎉 AUTO SUPPLY DATABASE BOOTSTRAP COMPLETE (ALL 4 BRANCHES A, B, C, D)! 🎉");
  process.exit(0);
}

seedAutoSupply()
  .catch((err) => {
    console.error("Auto Supply seed error:", err);
    process.exit(1);
  });
