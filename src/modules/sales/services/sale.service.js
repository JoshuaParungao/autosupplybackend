const { Prisma } = require("@prisma/client");

const prisma = require("../../../config/prisma");
const cashLinkService = require("../../cash-boxes/services/cashLink.service");
const incentiveService = require("../../incentives/services/incentive.service");
const {
  createReceivableAccount,
  recalculateReceivableForSale,
  deriveSourcePaymentStatus,
} = require("../../credit-accounts/services/receivableAccount.service");
const { createAuditLog } = require("../../../utils/auditLogger");
const { businessDateCode } = require("../../../utils/businessDate");
const {
  assertIdempotencyMatch,
  createIdempotencyFingerprint,
} = require("../../../utils/idempotency");
const notificationService = require("../../../services/notification.service");

const OWNER_ADMIN_ROLES = new Set(["SUPER_OWNER", "BRANCH_OWNER", "ADMIN"]);
const STAFF_ROLES = new Set(["CASHIER", "TECHNICIAN"]);

const sanitizeSaleCostSnapshotsForActor = (sale, actor) => {
  if (!sale) {
    return sale;
  }

  const { idempotencyKey, idempotencyFingerprint, ...safeSale } = sale;

  if (safeSale.creditAccount) {
    const {
      idempotencyKey: creditIdempotencyKey,
      idempotencyFingerprint: creditIdempotencyFingerprint,
      ...safeCreditAccount
    } = safeSale.creditAccount;

    const termKey = safeCreditAccount.term;
    const rawBasis = Number(safeCreditAccount.termBasis || 0);
    const basis =
      rawBasis > 0 && rawBasis < 1
        ? rawBasis
        : termKey === "STRAIGHT"
          ? 0.96
          : termKey === "CASH_PROMO"
            ? 1.0
            : rawBasis || 1;

    const cashTotal =
      Math.round(
        Number(
          safeCreditAccount.cashPromoTotalAmount ||
            safeCreditAccount.sourceTotalAmountSnapshot ||
            safeSale.grandTotal ||
            0
        ) * 100
      ) / 100;
    const regularAmount =
      Math.round(Number(safeCreditAccount.regularPriceTotalAmount || 0) * 100) / 100;

    if (
      basis < 1 &&
      cashTotal > 0 &&
      (regularAmount <= cashTotal || Math.abs(regularAmount - cashTotal) < 1)
    ) {
      const computedRegular = Math.round((cashTotal / basis) * 100) / 100;
      const dp =
        Math.round(
          Number(safeCreditAccount.downpaymentAmount || safeSale.amountPaid || 0) * 100
        ) / 100;
      const collected =
        Math.round(Number(safeCreditAccount.totalCollected || 0) * 100) / 100;
      const computedBalance = Math.max(
        0,
        Math.round((computedRegular - dp - collected) * 100) / 100
      );

      safeCreditAccount.termBasis = basis.toFixed(4);
      safeCreditAccount.regularPriceTotalAmount = computedRegular.toFixed(2);
      safeCreditAccount.balanceAmount = computedBalance.toFixed(2);
      safeCreditAccount.remainingBalance = computedBalance.toFixed(2);
    }

    safeSale.creditAccount = safeCreditAccount;
  }

  if (
    OWNER_ADMIN_ROLES.has(actor?.role) ||
    !Array.isArray(safeSale.items)
  ) {
    return safeSale;
  }

  return {
    ...safeSale,
    items: safeSale.items.map((saleItem) => {
      const {
        operationalUnitCostSnapshot,
        acquisitionUnitCostSnapshot,
        ...safeSaleItem
      } = saleItem;

      return safeSaleItem;
    }),
  };
};

const SALE_QUOTATION_SELECT = {
  id: true,
  quotationCode: true,
  status: true,
  preparedById: true,
  serviceDoneById: true,
  preparedBy: {
    select: {
      id: true,
      fullName: true,
      role: true,
    },
  },
  serviceDoneBy: {
    select: {
      id: true,
      fullName: true,
      role: true,
    },
  },
};

const isSuperOwner = (actor) => actor.role === "SUPER_OWNER";

const toMoney = (value) => {
  return Math.round(Number(value) * 100) / 100;
};

const toMoneyString = (value) => {
  return toMoney(value).toFixed(2);
};

const toDecimal = (value) => new Prisma.Decimal(value || 0);

const toMoneyDecimal = (value) =>
  toDecimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

const toQuantityDecimal = (value) =>
  toDecimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

const getItemPriceByTier = (item, tier) => {
  const priceMap = {
    1: item.price1,
    2: item.price2,
    3: item.price3,
    4: item.price4,
    5: item.price5,
  };

  return Number(priceMap[tier]);
};

const resolveMarkupPercent = (value) => {
  const markupPercent =
    value === undefined || value === null || value === ""
      ? 0
      : Number(value);

  if (
    !Number.isFinite(markupPercent) ||
    markupPercent < 0 ||
    markupPercent >= 100
  ) {
    const error = new Error("INVALID_MARKUP_PERCENT");
    error.statusCode = 400;
    throw error;
  }

  return markupPercent;
};

const applyMarkupToBasePrice = (basePrice, markupPercent) => {
  return toMoney(Number(basePrice) / (1 - Number(markupPercent) / 100));
};

const resolveBranchIdForCreate = (actor, requestedBranchId) => {
  if (isSuperOwner(actor)) {
    if (!requestedBranchId) {
      const error = new Error("BRANCH_REQUIRED");
      error.statusCode = 400;
      throw error;
    }

    return requestedBranchId;
  }

  if (!actor.branchId) {
    const error = new Error("BRANCH_REQUIRED");
    error.statusCode = 400;
    throw error;
  }

  if (requestedBranchId && requestedBranchId !== actor.branchId) {
    const error = new Error("BRANCH_ACCESS_DENIED");
    error.statusCode = 403;
    throw error;
  }

  return actor.branchId;
};

const ensureBranchExists = async (tx, branchId) => {
  const branch = await tx.branch.findUnique({
    where: {
      id: branchId,
    },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
    },
  });

  if (!branch) {
    const error = new Error("BRANCH_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  if (branch.status !== "ACTIVE") {
    const error = new Error("BRANCH_INACTIVE");
    error.statusCode = 400;
    throw error;
  }

  return branch;
};

const ensureCustomerBelongsToBranch = async (tx, customerId, branchId) => {
  if (!customerId) {
    return null;
  }

  const customer = await tx.customer.findFirst({
    where: {
      id: customerId,
      branchId,
    },
    select: {
      id: true,
      customerCode: true,
      fullName: true,
      status: true,
    },
  });

  if (!customer) {
    const error = new Error("CUSTOMER_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  if (customer.status !== "ACTIVE") {
    const error = new Error("CUSTOMER_INACTIVE");
    error.statusCode = 400;
    throw error;
  }

  return customer;
};

const ensureQuotationBelongsToBranch = async (tx, quotationId, branchId) => {
  if (!quotationId) {
    return null;
  }

  await tx.$queryRaw`
    SELECT "id"
    FROM "Quotation"
    WHERE "id" = ${quotationId}
    FOR UPDATE
  `;

  const quotation = await tx.quotation.findFirst({
    where: {
      id: quotationId,
      branchId,
    },
    select: {
      id: true,
      quotationCode: true,
      status: true,
      branchId: true,
      customerId: true,
      subtotal: true,
      totalDiscount: true,
      grandTotal: true,
      preparedById: true,
      serviceDoneById: true,
      items: {
        orderBy: {
          lineNo: "asc",
        },
        select: {
          id: true,
          lineNo: true,
          description: true,
          itemCodeSnapshot: true,
          itemNameSnapshot: true,
          brandSnapshot: true,
          modelSnapshot: true,
          priceTier: true,
          quantity: true,
          baseUnitPriceSnapshot: true,
          markupPercent: true,
          unitPrice: true,
          discountAmount: true,
          lineTotal: true,
          itemId: true,
          item: {
            select: {
              id: true,
              isSerialized: true,
            },
          },
        },
      },
      sales: {
        take: 1,
        select: {
          id: true,
        },
      },
    },
  });

  if (!quotation) {
    const error = new Error("QUOTATION_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  if (quotation.status === "CONVERTED" || quotation.sales.length > 0) {
    const error = new Error("QUOTATION_ALREADY_CONVERTED");
    error.statusCode = 400;
    throw error;
  }

  if (quotation.status === "CANCELLED" || quotation.status === "REJECTED") {
    const error = new Error("QUOTATION_CANCELLED");
    error.statusCode = 400;
    throw error;
  }

  return quotation;
};

const throwQuotationConversionError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const splitDiscountAcrossSerializedUnits = (discountAmount, quantity) => {
  const totalCents = Math.round(Number(discountAmount) * 100);
  const baseCents = Math.floor(totalCents / quantity);
  const remainder = totalCents % quantity;

  return Array.from({ length: quantity }, (_, index) => {
    return (baseCents + (index < remainder ? 1 : 0)) / 100;
  });
};

const buildQuotationConversionItems = (quotation, clientItems) => {
  const requestedItems = Array.isArray(clientItems) ? clientItems : [];
  const conversionItems = [];
  let clientIndex = 0;

  for (const quotationItem of quotation.items) {
    const isSerialized = Boolean(
      quotationItem.itemId && quotationItem.item?.isSerialized
    );
    const quotationQuantity = Number(quotationItem.quantity);

    if (
      isSerialized &&
      (!Number.isSafeInteger(quotationQuantity) || quotationQuantity < 1)
    ) {
      throwQuotationConversionError("QUOTATION_SERIALIZED_QUANTITY_INVALID");
    }

    const outputLineCount = isSerialized ? quotationQuantity : 1;
    const discounts = isSerialized
      ? splitDiscountAcrossSerializedUnits(
          quotationItem.discountAmount,
          outputLineCount
        )
      : [Number(quotationItem.discountAmount)];

    for (let unitIndex = 0; unitIndex < outputLineCount; unitIndex += 1) {
      const requestedItem = requestedItems[clientIndex];

      if (!requestedItem) {
        throwQuotationConversionError("QUOTATION_ITEMS_MISMATCH");
      }

      if (
        requestedItem.itemId &&
        requestedItem.itemId !== quotationItem.itemId
      ) {
        throwQuotationConversionError("QUOTATION_ITEMS_MISMATCH");
      }

      if (
        !quotationItem.itemId &&
        (requestedItem.itemId || requestedItem.batchId || requestedItem.serialId)
      ) {
        throwQuotationConversionError("QUOTATION_ITEMS_MISMATCH");
      }

      conversionItems.push({
        baseUnitPriceSnapshot:
          quotationItem.baseUnitPriceSnapshot == null
            ? null
            : Number(quotationItem.baseUnitPriceSnapshot),
        markupPercent:
          quotationItem.markupPercent == null
            ? null
            : Number(quotationItem.markupPercent),
        ...(quotationItem.itemId
          ? {
              itemId: quotationItem.itemId,
              priceTier: quotationItem.priceTier,
              batchId: requestedItem.batchId,
              serialId: requestedItem.serialId,
              itemCodeSnapshot: quotationItem.itemCodeSnapshot,
              itemNameSnapshot: quotationItem.itemNameSnapshot,
              brandSnapshot: quotationItem.brandSnapshot,
              modelSnapshot: quotationItem.modelSnapshot,
            }
          : {}),
        description: quotationItem.description,
        warrantyDuration: quotationItem.warrantyDuration,
        quantity: isSerialized ? 1 : quotationQuantity,
        unitPrice: Number(quotationItem.unitPrice),
        discountAmount: discounts[unitIndex],
      });

      clientIndex += 1;
    }
  }

  if (clientIndex !== requestedItems.length) {
    throwQuotationConversionError("QUOTATION_ITEMS_MISMATCH");
  }

  return conversionItems;
};

const buildQuotationConversionPayload = (quotation, payload) => {
  if (payload.customerId && payload.customerId !== quotation.customerId) {
    throwQuotationConversionError("QUOTATION_CUSTOMER_MISMATCH");
  }

  if (toMoney(payload.serviceCharge || 0) !== 0) {
    throwQuotationConversionError("QUOTATION_SERVICE_CHARGE_NOT_ALLOWED");
  }

  return {
    ...payload,
    customerId: quotation.customerId || null,
    serviceCharge: 0,
    items: buildQuotationConversionItems(quotation, payload.items),
  };
};

const generateReceiptCode = async (tx, branchCode, branchId) => {
  const existingSales = await tx.sale.findMany({
    where: {
      branchId,
    },
    select: {
      receiptCode: true,
    },
  });

  let highestNumber = 0;

  for (const sale of existingSales) {
    const raw = String(sale.receiptCode || "").trim();
    // Match pure digits or trailing digits from legacy formats (e.g., RCPT-...-005)
    const match = raw.match(/\d+$/);
    if (match) {
      const num = Number.parseInt(match[0], 10);
      if (!Number.isNaN(num) && num > highestNumber) {
        highestNumber = num;
      }
    }
  }

  let nextNumber = highestNumber + 1;
  let receiptCode = String(nextNumber).padStart(5, "0");

  // Collision check
  let exists = await tx.sale.findFirst({
    where: {
      branchId,
      receiptCode,
    },
    select: {
      id: true,
    },
  });

  while (exists) {
    nextNumber += 1;
    receiptCode = String(nextNumber).padStart(5, "0");
    exists = await tx.sale.findFirst({
      where: {
        branchId,
        receiptCode,
      },
      select: {
        id: true,
      },
    });
  }

  return receiptCode;
};

const generateSaleInventoryMovementCode = async (tx, branchCode, itemCode, branchId) => {
  const prefix = `MOV-${branchCode}-${itemCode}-SALEOUT-`;

  const count = await tx.inventoryMovement.count({
    where: {
      branchId,
      movementCode: {
        startsWith: prefix,
      },
    },
  });

  return `${prefix}${String(count + 1).padStart(3, "0")}`;
};

const generateUniqueAutoBatchCode = async (tx, branchId) => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let count = (await tx.inventoryBatch.count({ where: { branchId } })) + 1;
  let candidate = `BAT-${dateStr}-${String(count).padStart(4, "0")}`;

  while (
    await tx.inventoryBatch.findFirst({
      where: { branchId, batchCode: candidate },
      select: { id: true },
    })
  ) {
    count += 1;
    candidate = `BAT-${dateStr}-${String(count).padStart(4, "0")}`;
  }

  return candidate;
};

const deductBatchStock = async ({
  tx,
  actor,
  branchId,
  item,
  batchId,
  quantity,
}) => {
  await tx.$queryRaw`
    SELECT "id"
    FROM "InventoryBatch"
    WHERE "id" = ${batchId}
    FOR UPDATE
  `;

  let batch = await tx.inventoryBatch.findFirst({
    where: {
      id: batchId,
      branchId,
      itemId: item.id,
      status: "ACTIVE",
    },
  });

  if (!batch) {
    const anyBatch = await tx.inventoryBatch.findFirst({
      where: {
        id: batchId,
        branchId,
        itemId: item.id,
      },
    });

    if (anyBatch) {
      batch = anyBatch;
    }
  }

  if (!batch) {
    const error = new Error("BATCH_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  const previousQuantity = Number(batch.quantityAvailable);
  const newQuantity = toMoney(previousQuantity - quantity);

  if (newQuantity < 0) {
    const error = new Error("INSUFFICIENT_BATCH_QUANTITY");
    error.statusCode = 400;
    throw error;
  }

  await tx.inventoryBatch.update({
    where: {
      id: batch.id,
    },
    data: {
      quantityAvailable: toMoneyString(newQuantity),
      status: newQuantity === 0 ? "DEPLETED" : "ACTIVE",
      updatedById: actor.id,
    },
  });

  return {
    batch,
    previousQuantity,
    newQuantity,
  };
};

const buildSaleItems = async (
  tx,
  actor,
  branchId,
  items,
  { trustedQuotation = false } = {}
) => {
  const saleItems = [];
  const stockDeductions = [];
  let subtotal = 0;
  let totalDiscount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const itemPayload = items[index];
    const quantity = toMoney(itemPayload.quantity);
    const discountAmount = toMoney(itemPayload.discountAmount || 0);

    let item = null;
    let unitPrice = 0;
    let baseUnitPriceSnapshot = null;
    let markupPercent = null;
    const hasExplicitMarkup = itemPayload.markupPercent !== undefined;
    let description = itemPayload.description ? String(itemPayload.description).trim() : "";
    let priceTier = itemPayload.priceTier || null;
    let resolvedBatchId = itemPayload.batchId || null;
    let resolvedSerialId = itemPayload.serialId || null;
    let stockDeduction = null;

    if (itemPayload.itemId) {
      item = await tx.item.findFirst({
        where: {
          id: itemPayload.itemId,
          branchId,
          status: "ACTIVE",
        },
      });

      if (!item) {
        const error = new Error("ITEM_NOT_FOUND");
        error.statusCode = 404;
        throw error;
      }

      if (!priceTier) {
        const error = new Error("PRICE_TIER_REQUIRED");
        error.statusCode = 400;
        throw error;
      }

      baseUnitPriceSnapshot = toMoney(getItemPriceByTier(item, priceTier));
      markupPercent = resolveMarkupPercent(itemPayload.markupPercent);
      unitPrice = applyMarkupToBasePrice(baseUnitPriceSnapshot, markupPercent);
      description = description || item.itemName;

      if (trustedQuotation) {
        baseUnitPriceSnapshot =
          itemPayload.baseUnitPriceSnapshot == null
            ? null
            : toMoney(itemPayload.baseUnitPriceSnapshot);
        markupPercent =
          itemPayload.markupPercent == null
            ? null
            : resolveMarkupPercent(itemPayload.markupPercent);
        unitPrice = toMoney(itemPayload.unitPrice);
      } else if (
        !hasExplicitMarkup &&
        STAFF_ROLES.has(actor.role) &&
        itemPayload.unitPrice !== undefined
      ) {
        if (toMoney(itemPayload.unitPrice) !== baseUnitPriceSnapshot) {
          const error = new Error("STAFF_CUSTOM_PRICE_NOT_ALLOWED");
          error.statusCode = 403;
          throw error;
        }
      } else if (
        !hasExplicitMarkup &&
        OWNER_ADMIN_ROLES.has(actor.role) &&
        itemPayload.unitPrice !== undefined
      ) {
        unitPrice = toMoney(itemPayload.unitPrice);
        markupPercent = null;
      }

      if (item.isSerialized) {
        if (quantity !== 1) {
          const error = new Error("SERIALIZED_QUANTITY_MUST_BE_ONE");
          error.statusCode = 400;
          throw error;
        }

        const inputSerialString = itemPayload.serialNumber
          ? String(itemPayload.serialNumber).trim()
          : "";

        let serial = null;

        if (resolvedSerialId) {
          await tx.$queryRaw`
            SELECT "id"
            FROM "ItemSerial"
            WHERE "id" = ${resolvedSerialId}
            FOR UPDATE
          `;

          serial = await tx.itemSerial.findFirst({
            where: {
              id: resolvedSerialId,
              branchId,
              itemId: item.id,
            },
          });
        } else if (inputSerialString) {
          serial = await tx.itemSerial.findFirst({
            where: {
              branchId,
              itemId: item.id,
              serialNumber: inputSerialString,
            },
          });

          if (serial) {
            await tx.$queryRaw`
              SELECT "id"
              FROM "ItemSerial"
              WHERE "id" = ${serial.id}
              FOR UPDATE
            `;
          }
        }

        if (serial) {
          if (serial.status !== "AVAILABLE") {
            const error = new Error("SERIAL_NOT_AVAILABLE");
            error.statusCode = 400;
            throw error;
          }

          let batchToUse = null;

          if (serial.batchId) {
            batchToUse = await tx.inventoryBatch.findFirst({
              where: {
                id: serial.batchId,
                branchId,
                itemId: item.id,
                status: "ACTIVE",
                quantityAvailable: { gte: "1" },
              },
            });
          }

          if (!batchToUse) {
            batchToUse = await tx.inventoryBatch.findFirst({
              where: {
                branchId,
                itemId: item.id,
                status: "ACTIVE",
                quantityAvailable: { gte: "1" },
              },
              orderBy: { createdAt: "desc" },
            });
          }

          if (!batchToUse && serial.batchId) {
            const existingDepletedBatch = await tx.inventoryBatch.findFirst({
              where: {
                id: serial.batchId,
                branchId,
                itemId: item.id,
              },
            });
            if (existingDepletedBatch) {
              batchToUse = await tx.inventoryBatch.update({
                where: { id: existingDepletedBatch.id },
                data: {
                  quantityAvailable: "1",
                  status: "ACTIVE",
                  updatedById: actor.id,
                },
              });
            }
          }

          if (!batchToUse) {
            const autoBatchCode = await generateUniqueAutoBatchCode(tx, branchId);
            batchToUse = await tx.inventoryBatch.create({
              data: {
                branchId,
                itemId: item.id,
                batchCode: autoBatchCode,
                quantityIn: "1",
                quantityAvailable: "1",
                unitCost: item.costPrice.toString(),
                operationalUnitCost: item.costPrice.toString(),
                sellingPrice1: item.price1.toString(),
                sellingPrice2: item.price2.toString(),
                sellingPrice3: item.price3.toString(),
                sellingPrice4: item.price4.toString(),
                sellingPrice5: item.price5.toString(),
                remarks: "Auto-created for available serial checkout",
                status: "ACTIVE",
                createdById: actor.id,
                updatedById: actor.id,
              },
            });
          }

          resolvedBatchId = batchToUse.id;

          const deduction = await deductBatchStock({
            tx,
            actor,
            branchId,
            item,
            batchId: resolvedBatchId,
            quantity,
          });

          await tx.itemSerial.update({
            where: {
              id: serial.id,
            },
            data: {
              batchId: resolvedBatchId,
              status: "SOLD",
              updatedById: actor.id,
            },
          });

          resolvedSerialId = serial.id;

          stockDeduction = {
            branchId,
            itemId: item.id,
            itemCode: item.itemCode,
            batchId: deduction.batch.id,
            serialId: serial.id,
            quantity,
            previousQuantity: deduction.previousQuantity,
            newQuantity: deduction.newQuantity,
            acquisitionUnitCost: deduction.batch.unitCost,
            operationalUnitCost:
              deduction.batch.operationalUnitCost ?? deduction.batch.unitCost,
          };
        } else if (inputSerialString) {
          // On-the-fly auto registration of scanned/typed serial not currently in inventory
          let targetBatch = null;

          if (resolvedBatchId) {
            targetBatch = await tx.inventoryBatch.findFirst({
              where: {
                id: resolvedBatchId,
                branchId,
                itemId: item.id,
                status: "ACTIVE",
                quantityAvailable: { gte: "1" },
              },
            });
          }

          if (!targetBatch) {
            targetBatch = await tx.inventoryBatch.findFirst({
              where: {
                branchId,
                itemId: item.id,
                status: "ACTIVE",
                quantityAvailable: { gte: "1" },
              },
              orderBy: { createdAt: "desc" },
            });
          }

          if (!targetBatch) {
            const autoBatchCode = await generateUniqueAutoBatchCode(tx, branchId);

            targetBatch = await tx.inventoryBatch.create({
              data: {
                branchId,
                itemId: item.id,
                batchCode: autoBatchCode,
                quantityIn: "1",
                quantityAvailable: "1",
                unitCost: item.costPrice.toString(),
                operationalUnitCost: item.costPrice.toString(),
                sellingPrice1: item.price1.toString(),
                sellingPrice2: item.price2.toString(),
                sellingPrice3: item.price3.toString(),
                sellingPrice4: item.price4.toString(),
                sellingPrice5: item.price5.toString(),
                remarks: "Auto-created from POS serial barcode scan",
                status: "ACTIVE",
                createdById: actor.id,
                updatedById: actor.id,
              },
            });
          }

          const deduction = await deductBatchStock({
            tx,
            actor,
            branchId,
            item,
            batchId: targetBatch.id,
            quantity: 1,
          });

          const newSerial = await tx.itemSerial.create({
            data: {
              branchId,
              itemId: item.id,
              batchId: targetBatch.id,
              serialNumber: inputSerialString,
              status: "SOLD",
              remarks: "Auto-registered from POS scanner",
              createdById: actor.id,
              updatedById: actor.id,
            },
          });

          resolvedSerialId = newSerial.id;
          resolvedBatchId = targetBatch.id;

          stockDeduction = {
            branchId,
            itemId: item.id,
            itemCode: item.itemCode,
            batchId: deduction.batch.id,
            serialId: newSerial.id,
            quantity,
            previousQuantity: deduction.previousQuantity,
            newQuantity: deduction.newQuantity,
            acquisitionUnitCost: deduction.batch.unitCost,
            operationalUnitCost:
              deduction.batch.operationalUnitCost ?? deduction.batch.unitCost,
          };
        } else {
          const error = new Error("SERIAL_REQUIRED");
          error.statusCode = 400;
          throw error;
        }
      } else {
        if (resolvedSerialId) {
          const error = new Error("SERIAL_NOT_ALLOWED_FOR_NON_SERIALIZED_ITEM");
          error.statusCode = 400;
          throw error;
        }

        let targetBatch = null;

        if (resolvedBatchId) {
          targetBatch = await tx.inventoryBatch.findFirst({
            where: {
              id: resolvedBatchId,
              branchId,
              itemId: item.id,
              status: "ACTIVE",
            },
          });
        }

        if (!targetBatch || Number(targetBatch.quantityAvailable || 0) < quantity) {
          const fallbackBatch = await tx.inventoryBatch.findFirst({
            where: {
              branchId,
              itemId: item.id,
              status: "ACTIVE",
              quantityAvailable: { gte: toMoneyString(quantity) },
            },
            orderBy: { createdAt: "desc" },
          });
          if (fallbackBatch) {
            targetBatch = fallbackBatch;
            resolvedBatchId = fallbackBatch.id;
          }
        }

        if (!targetBatch) {
          const error = new Error("BATCH_NOT_FOUND");
          error.statusCode = 404;
          throw error;
        }

        const deduction = await deductBatchStock({
          tx,
          actor,
          branchId,
          item,
          batchId: targetBatch.id,
          quantity,
        });

        stockDeduction = {
          branchId,
          itemId: item.id,
          itemCode: item.itemCode,
          batchId: deduction.batch.id,
          serialId: null,
          quantity,
          previousQuantity: deduction.previousQuantity,
          newQuantity: deduction.newQuantity,
          acquisitionUnitCost: deduction.batch.unitCost,
          operationalUnitCost:
            deduction.batch.operationalUnitCost ?? deduction.batch.unitCost,
        };
      }
    } else {
      if (resolvedBatchId || resolvedSerialId) {
        const error = new Error("CUSTOM_LINE_INVENTORY_LINK_NOT_ALLOWED");
        error.statusCode = 400;
        throw error;
      }

      if (!description) {
        const error = new Error("DESCRIPTION_REQUIRED");
        error.statusCode = 400;
        throw error;
      }

      if (itemPayload.unitPrice === undefined) {
        const error = new Error("UNIT_PRICE_REQUIRED");
        error.statusCode = 400;
        throw error;
      }

      if (trustedQuotation) {
        baseUnitPriceSnapshot =
          itemPayload.baseUnitPriceSnapshot == null
            ? toMoney(itemPayload.unitPrice)
            : toMoney(itemPayload.baseUnitPriceSnapshot);
        markupPercent =
          itemPayload.markupPercent == null
            ? null
            : resolveMarkupPercent(itemPayload.markupPercent);
        unitPrice = toMoney(itemPayload.unitPrice);
      } else {
        baseUnitPriceSnapshot = toMoney(itemPayload.unitPrice);
        markupPercent = resolveMarkupPercent(itemPayload.markupPercent);
        unitPrice = applyMarkupToBasePrice(
          baseUnitPriceSnapshot,
          markupPercent
        );
      }
    }

    const grossLineTotal = toMoney(quantity * unitPrice);

    if (discountAmount > grossLineTotal) {
      const error = new Error("DISCOUNT_EXCEEDS_LINE_TOTAL");
      error.statusCode = 400;
      throw error;
    }

    const lineTotal = toMoney(grossLineTotal - discountAmount);

    subtotal += grossLineTotal;
    totalDiscount += discountAmount;

    if (stockDeduction) {
      stockDeductions.push(stockDeduction);
    }

    saleItems.push({
      lineNo: index + 1,
      description,
      itemCodeSnapshot:
        trustedQuotation && item
          ? itemPayload.itemCodeSnapshot
          : item
            ? item.itemCode
            : null,
      itemNameSnapshot:
        trustedQuotation && item
          ? itemPayload.itemNameSnapshot
          : item
            ? item.itemName
            : null,
      brandSnapshot:
        trustedQuotation && item
          ? itemPayload.brandSnapshot
          : item
            ? item.brand
            : null,
      modelSnapshot:
        trustedQuotation && item
          ? itemPayload.modelSnapshot
          : item
            ? item.modelName
            : null,
      priceTier,
      baseUnitPriceSnapshot:
        baseUnitPriceSnapshot !== null
          ? toMoneyString(baseUnitPriceSnapshot)
          : null,
      markupPercent:
        markupPercent !== null
          ? Number(markupPercent).toFixed(4)
          : null,
      quantity: toMoneyString(quantity),
      unitPrice: toMoneyString(unitPrice),
      discountAmount: toMoneyString(discountAmount),
      lineTotal: toMoneyString(lineTotal),
      operationalUnitCostSnapshot: stockDeduction
        ? stockDeduction.operationalUnitCost.toString()
        : null,
      acquisitionUnitCostSnapshot: stockDeduction
        ? stockDeduction.acquisitionUnitCost.toString()
        : null,
      itemId: item ? item.id : null,
      batchId: resolvedBatchId,
      serialId: resolvedSerialId,
      warrantyDuration: itemPayload.warrantyDuration
        ? String(itemPayload.warrantyDuration).trim()
        : null,
    });
  }

  return {
    saleItems,
    stockDeductions,
    subtotal: toMoney(subtotal),
    totalDiscount: toMoney(totalDiscount),
  };
};

const buildSalePayments = (actor, payments = []) => {
  let amountPaid = 0;

  const salePayments = payments.map((payment) => {
    const amount = toMoney(payment.amount);
    amountPaid += amount;

    return {
      paymentMethod: payment.paymentMethod,
      amount: toMoneyString(amount),
      referenceNo: payment.referenceNo || null,
      remarks: payment.remarks || null,
      createdById: actor.id,
    };
  });

  return {
    salePayments,
    amountPaid: toMoney(amountPaid),
  };
};

const computePaymentStatus = (amountPaid, grandTotal) => {
  if (amountPaid <= 0) {
    return "UNPAID";
  }

  if (amountPaid < grandTotal) {
    return "PARTIALLY_PAID";
  }

  return "PAID";
};

const calculateNetCashReceived = (cashPaymentTotal, changeAmount) => {
  const cashTender = toMoney(cashPaymentTotal);
  const change = toMoney(changeAmount);

  if (change > cashTender) {
    const error = new Error("SALE_CHANGE_EXCEEDS_CASH_TENDER");
    error.statusCode = 400;
    throw error;
  }

  return toMoney(cashTender - change);
};

const createSale = async (actor, payload, database = prisma) => {
  const branchId = resolveBranchIdForCreate(actor, payload.branchId);
  const idempotencyFingerprint = payload.idempotencyKey
    ? createIdempotencyFingerprint({ branchId, payload })
    : null;

  const createdSale = await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${branchId} FOR UPDATE`;

    const branch = await ensureBranchExists(tx, branchId);

    if (payload.idempotencyKey) {
      const existingSale = await tx.sale.findUnique({
        where: {
          branchId_idempotencyKey: {
            branchId,
            idempotencyKey: payload.idempotencyKey,
          },
        },
        include: SALE_CREATE_INCLUDE,
      });

      if (existingSale) {
        assertIdempotencyMatch(
          existingSale,
          idempotencyFingerprint,
          "SALE_IDEMPOTENCY_CONFLICT"
        );
        existingSale.replayed = true;
        return sanitizeSaleCostSnapshotsForActor(existingSale, actor);
      }
    }

    const quotation = await ensureQuotationBelongsToBranch(tx, payload.quotationId, branchId);
    const salePayload = quotation
      ? buildQuotationConversionPayload(quotation, payload)
      : payload;

    await ensureCustomerBelongsToBranch(tx, salePayload.customerId, branchId);

    const { saleItems, stockDeductions, subtotal, totalDiscount } = await buildSaleItems(
      tx,
      actor,
      branchId,
      salePayload.items,
      { trustedQuotation: Boolean(quotation) }
    );

    const serviceCharge = toMoney(salePayload.serviceCharge || 0);
    const grandTotal = toMoney(subtotal - totalDiscount + serviceCharge);

    if (
      quotation &&
      (toMoney(quotation.subtotal) !== subtotal ||
        toMoney(quotation.totalDiscount) !== totalDiscount ||
        toMoney(quotation.grandTotal) !== grandTotal)
    ) {
      throwQuotationConversionError("QUOTATION_TOTAL_MISMATCH");
    }

    const { salePayments, amountPaid } = buildSalePayments(
      actor,
      salePayload.payments
    );
    const hasReceivable = Boolean(salePayload.receivable);

    if (hasReceivable && amountPaid > grandTotal) {
      const error = new Error("RECEIVABLE_INITIAL_SETTLEMENT_EXCEEDS_TOTAL");
      error.statusCode = 400;
      throw error;
    }

    if (hasReceivable && amountPaid === grandTotal) {
      const error = new Error("RECEIVABLE_BALANCE_REQUIRED");
      error.statusCode = 400;
      throw error;
    }

    if (!hasReceivable && amountPaid < grandTotal) {
      const error = new Error("RECEIVABLE_REQUIRED_FOR_OUTSTANDING_BALANCE");
      error.statusCode = 400;
      throw error;
    }

    const paymentStatus = hasReceivable
      ? amountPaid > 0
        ? "PARTIALLY_PAID"
        : "UNPAID"
      : computePaymentStatus(amountPaid, grandTotal);
    const changeAmount = toMoney(Math.max(amountPaid - grandTotal, 0));
    const cashPaymentTotal = toMoney(
      salePayments
        .filter((payment) => payment.paymentMethod === "CASH")
        .reduce((sum, payment) => sum + Number(payment.amount), 0)
    );

    const netCashReceived = calculateNetCashReceived(
      cashPaymentTotal,
      changeAmount
    );

    const receiptCode = await generateReceiptCode(tx, branch.code, branchId);

    for (const deduction of stockDeductions) {
      const movementCode = await generateSaleInventoryMovementCode(
        tx,
        branch.code,
        deduction.itemCode,
        branchId
      );

      await tx.inventoryMovement.create({
        data: {
          branchId,
          itemId: deduction.itemId,
          batchId: deduction.batchId,
          serialId: deduction.serialId,
          movementCode,
          type: "SALE_OUT",
          source: "SALE",
          quantity: toMoneyString(deduction.quantity),
          previousQuantity: toMoneyString(deduction.previousQuantity),
          newQuantity: toMoneyString(deduction.newQuantity),
          unitCost: deduction.acquisitionUnitCost.toString(),
          referenceNo: receiptCode,
          remarks: `Sale stock deduction for ${receiptCode}.`,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
    }

    let assignedCashierId = actor.id;
    if (salePayload.cashierId && salePayload.cashierId !== actor.id) {
      const assignedUser = await tx.user.findFirst({
        where: {
          id: salePayload.cashierId,
          isActive: true,
          OR: [
            { branchId: branchId },
            { branchId: null },
            { role: "SUPER_OWNER" },
          ],
        },
        select: {
          id: true,
        },
      });
      if (assignedUser) {
        assignedCashierId = assignedUser.id;
      }
    }

    const sale = await tx.sale.create({
      data: {
        receiptCode,
        status: "COMPLETED",
        paymentStatus,
        subtotal: toMoneyString(subtotal),
        totalDiscount: toMoneyString(totalDiscount),
        serviceCharge: toMoneyString(serviceCharge),
        grandTotal: toMoneyString(grandTotal),
        amountPaid: toMoneyString(amountPaid),
        changeAmount: toMoneyString(changeAmount),
        idempotencyKey: payload.idempotencyKey || null,
        idempotencyFingerprint,
        remarks: salePayload.remarks || null,
        branchId,
        customerId: salePayload.customerId || null,
        quotationId: salePayload.quotationId || null,
        cashierId: assignedCashierId,
        createdById: actor.id,
        updatedById: actor.id,
        items: {
          create: saleItems,
        },
        payments: {
          create: salePayments,
        },
      },
      include: SALE_CREATE_INCLUDE,
    });

    if (quotation) {
      await tx.quotation.update({
        where: {
          id: quotation.id,
        },
        data: {
          status: "CONVERTED",
          convertedAt: new Date(),
          updatedById: actor.id,
        },
      });

      sale.quotation.status = "CONVERTED";
    }

    if (hasReceivable) {
      sale.creditAccount = await createReceivableAccount(tx, actor, {
        branch,
        sourceType: "SALE",
        sourceId: sale.id,
        sourceCode: sale.receiptCode,
        sourceTotalAmount: grandTotal,
        initialSettlementAmount: amountPaid,
        customerId: sale.customerId,
        idempotencyKey: null,
        idempotencyFingerprint: null,
        receivable: salePayload.receivable,
      });
    }
    if (netCashReceived > 0) {
      await cashLinkService.postSystemCashIn(tx, actor, branch, {
        type: "SALE_PAYMENT",
        source: "SALE",
        amount: netCashReceived,
        description: `Net cash received from sale ${receiptCode} after change.`,
        referenceNo: null,
        sourceId: sale.id,
        sourceCode: receiptCode,
        transactionDate: sale.saleDate,
      });
    }

    await incentiveService.postSaleIncentives(tx, actor, sale.id);

    await createAuditLog(
      {
        actor,
        branchId,
        action: "SALE_CREATED",
        entityType: "Sale",
        entityId: sale.id,
        description: `Sale ${sale.receiptCode} created`,
        metadata: {
          receiptCode: sale.receiptCode,
          customerId: sale.customerId,
          quotationId: sale.quotationId,
          grandTotal: toMoneyString(grandTotal),
          amountPaid: toMoneyString(amountPaid),
          changeAmount: toMoneyString(changeAmount),
          netCashReceived: toMoneyString(netCashReceived),
          paymentStatus,
          receivableProvider: salePayload.receivable?.provider || null,
          creditAccountId: sale.creditAccount?.id || null,
        },
      },
      tx
    );

    sale.replayed = false;
    return sanitizeSaleCostSnapshotsForActor(sale, actor);
  });

  if (createdSale && !createdSale.replayed) {
    notificationService.dispatchPaymentReceived(createdSale);
  }

  return createdSale;
};


const parsePagination = (query) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
  };
};

const resolveBranchFilterForRead = (actor, requestedBranchId) => {
  if (isSuperOwner(actor)) {
    return requestedBranchId || undefined;
  }

  return actor.branchId;
};

const ensureCanAccessSaleBranch = (actor, sale) => {
  if (isSuperOwner(actor)) {
    return;
  }

  if (!actor.branchId || sale.branchId !== actor.branchId) {
    const error = new Error("SALE_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }
};

const getSales = async (actor, query) => {
  const { page, limit, skip } = parsePagination(query);
  const branchId = resolveBranchFilterForRead(actor, query.branchId);

  const where = {};

  if (branchId) {
    where.branchId = branchId;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.paymentStatus) {
    where.paymentStatus = query.paymentStatus;
  }

  if (query.customerId) {
    where.customerId = query.customerId;
  }

  if (query.cashierId) {
    where.cashierId = query.cashierId;
  }

  const rawPriceTier = query.priceTier || query.priceTiers;
  if (rawPriceTier !== undefined && rawPriceTier !== null && rawPriceTier !== "") {
    const rawStr = String(rawPriceTier);
    const tiers = rawStr
      .split(",")
      .map((t) => Number(t.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);

    if (tiers.length === 1) {
      where.items = {
        some: {
          priceTier: tiers[0],
        },
      };
    } else if (tiers.length > 1) {
      where.items = {
        some: {
          priceTier: { in: tiers },
        },
      };
    }
  }

  if (query.startDate || query.endDate) {
    where.saleDate = {};
    if (query.startDate) {
      const parsedStart = new Date(query.startDate);
      if (!Number.isNaN(parsedStart.getTime())) {
        where.saleDate.gte = parsedStart;
      }
    }
    if (query.endDate) {
      const parsedEnd = new Date(query.endDate);
      if (!Number.isNaN(parsedEnd.getTime())) {
        where.saleDate.lte = parsedEnd;
      }
    }
  }

  if (query.search) {
    const search = String(query.search).trim();

    where.OR = [
      {
        receiptCode: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        remarks: {
          contains: search,
          mode: "insensitive",
        },
      },
      {
        customer: {
          fullName: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
      {
        customer: {
          customerCode: {
            contains: search,
            mode: "insensitive",
          },
        },
      },
    ];
  }

  const [sales, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      skip,
      take: limit,
      orderBy: {
        saleDate: "desc",
      },
      include: {
        branch: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        customer: {
          select: {
            id: true,
            customerCode: true,
            fullName: true,
            mobileNumber: true,
            email: true,
          },
        },
        quotation: {
          select: SALE_QUOTATION_SELECT,
        },
        cashier: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
        creditAccount: {
          select: {
            id: true,
            creditCode: true,
            provider: true,
            term: true,
            termBasis: true,
            cashPromoTotalAmount: true,
            sourceTotalAmountSnapshot: true,
            downpaymentAmount: true,
            balanceAmount: true,
            totalCollected: true,
            regularPriceTotalAmount: true,
            remainingBalance: true,
            status: true,
          },
        },
        payments: {
          select: {
            id: true,
            paymentMethod: true,
            amount: true,
            referenceNo: true,
            paidAt: true,
          },
        },
        items: {
          orderBy: {
            lineNo: "asc",
          },
          include: {
            item: {
              select: {
                id: true,
                itemCode: true,
                itemName: true,
                isSerialized: true,
                hasWarranty: true,
              },
            },
            batch: {
              select: {
                id: true,
                batchCode: true,
              },
            },
            serial: {
              select: {
                id: true,
                serialNumber: true,
                status: true,
              },
            },
          },
        },
        _count: {
          select: {
            items: true,
            payments: true,
          },
        },
      },
    }),
    prisma.sale.count({
      where,
    }),
  ]);

  return {
    data: sales.map((sale) => sanitizeSaleCostSnapshotsForActor(sale, actor)),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const getSaleById = async (actor, saleId) => {
  const sale = await prisma.sale.findUnique({
    where: {
      id: saleId,
    },
    include: {
      branch: {
        select: {
          id: true,
          code: true,
          name: true,
        },
      },
      customer: {
        select: {
          id: true,
          customerCode: true,
          fullName: true,
          mobileNumber: true,
          email: true,
        },
      },
      quotation: {
        select: SALE_QUOTATION_SELECT,
      },
      cashier: {
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
        },
      },
      updatedBy: {
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
        },
      },
      cancelledBy: {
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
        },
      },
      items: {
        orderBy: {
          lineNo: "asc",
        },
        include: {
          item: {
            select: {
              id: true,
              itemCode: true,
              itemName: true,
              isSerialized: true,
              hasWarranty: true,
            },
          },
          batch: {
            select: {
              id: true,
              batchCode: true,
            },
          },
          serial: {
            select: {
              id: true,
              serialNumber: true,
              status: true,
            },
          },
        },
      },
      payments: {
        orderBy: {
          paidAt: "asc",
        },
      },
      creditAccount: {
        select: {
          id: true,
          creditCode: true,
          status: true,
          sourceType: true,
          provider: true,
          sourceTotalAmountSnapshot: true,
          providerReferenceNo: true,
          term: true,
          termBasis: true,
          downpaymentAmount: true,
          balanceAmount: true,
          totalCollected: true,
          regularPriceTotalAmount: true,
          remainingBalance: true,
          monthlyDueAmount: true,
        },
      },
      returnRequests: {
        where: {
          status: "COMPLETED",
        },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        include: {
          items: {
            orderBy: {
              lineNo: "asc",
            },
            include: {
              serial: {
                select: {
                  id: true,
                  serialNumber: true,
                  status: true,
                },
              },
            },
          },
          createdBy: {
            select: {
              id: true,
              fullName: true,
              role: true,
            },
          },
          completedBy: {
            select: {
              id: true,
              fullName: true,
              role: true,
            },
          },
        },
      },
    },
  });

  if (!sale) {
    const error = new Error("SALE_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  ensureCanAccessSaleBranch(actor, sale);

  const returnedQuantityBySaleItem = new Map();

  for (const returnRequest of sale.returnRequests) {
    for (const returnItem of returnRequest.items) {
      if (!returnItem.saleItemId) continue;
      const current = returnedQuantityBySaleItem.get(returnItem.saleItemId) || toDecimal(0);
      returnedQuantityBySaleItem.set(
        returnItem.saleItemId,
        current.plus(returnItem.quantity)
      );
    }
  }

  return sanitizeSaleCostSnapshotsForActor({
    ...sale,
    items: sale.items.map((saleItem) => {
      const returnedQuantity = returnedQuantityBySaleItem.get(saleItem.id) || toDecimal(0);
      const remainingReturnQuantity = Prisma.Decimal.max(
        toDecimal(saleItem.quantity).minus(returnedQuantity),
        toDecimal(0)
      );

      return {
        ...saleItem,
        isSerialized: Boolean(saleItem.item?.isSerialized),
        serialNumber: saleItem.serial?.serialNumber || null,
        returnedQuantity: returnedQuantity.toDecimalPlaces(2).toString(),
        remainingReturnQuantity: remainingReturnQuantity
          .toDecimalPlaces(2)
          .toString(),
      };
    }),
  }, actor);
};


const generateSaleCancelMovementCode = async (tx, branchCode, itemCode, branchId) => {
  const prefix = `MOV-${branchCode}-${itemCode}-CANCELIN-`;

  const count = await tx.inventoryMovement.count({
    where: {
      branchId,
      movementCode: {
        startsWith: prefix,
      },
    },
  });

  return `${prefix}${String(count + 1).padStart(3, "0")}`;
};

const restoreSaleItemStock = async ({ tx, actor, sale, saleItem }) => {
  if (!saleItem.itemId || !saleItem.batchId) {
    return;
  }

  await tx.$queryRaw`SELECT "id" FROM "InventoryBatch" WHERE "id" = ${saleItem.batchId} FOR UPDATE`;

  const batch = await tx.inventoryBatch.findUnique({
    where: {
      id: saleItem.batchId,
    },
  });

  if (!batch) {
    const error = new Error("BATCH_NOT_FOUND");
    error.statusCode = 404;
    throw error;
  }

  const previousQuantity = Number(batch.quantityAvailable);
  const restoreQuantity = toMoney(saleItem.quantity);
  const newQuantity = toMoney(previousQuantity + restoreQuantity);

  await tx.inventoryBatch.update({
    where: {
      id: batch.id,
    },
    data: {
      quantityAvailable: toMoneyString(newQuantity),
      status: "ACTIVE",
      updatedById: actor.id,
    },
  });

  if (saleItem.serialId) {
    await tx.$queryRaw`SELECT "id" FROM "ItemSerial" WHERE "id" = ${saleItem.serialId} FOR UPDATE`;

    const serial = await tx.itemSerial.findUnique({
      where: {
        id: saleItem.serialId,
      },
    });

    if (!serial) {
      const error = new Error("SERIAL_NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (serial.status !== "SOLD") {
      const error = new Error("SERIAL_CANCEL_STATUS_INVALID");
      error.statusCode = 400;
      throw error;
    }

    await tx.itemSerial.update({
      where: {
        id: serial.id,
      },
      data: {
        status: "AVAILABLE",
        updatedById: actor.id,
      },
    });
  }

  const itemCode = saleItem.itemCodeSnapshot || "ITEM";
  const movementCode = await generateSaleCancelMovementCode(
    tx,
    sale.branch.code,
    itemCode,
    sale.branchId
  );

  await tx.inventoryMovement.create({
    data: {
      branchId: sale.branchId,
      itemId: saleItem.itemId,
      batchId: saleItem.batchId,
      serialId: saleItem.serialId || null,
      movementCode,
      type: "RETURN_IN",
      source: "SALE",
      quantity: toMoneyString(restoreQuantity),
      previousQuantity: toMoneyString(previousQuantity),
      newQuantity: toMoneyString(newQuantity),
      unitCost: batch.unitCost.toString(),
      referenceNo: sale.receiptCode,
      remarks: `Sale cancellation stock restore for ${sale.receiptCode}.`,
      createdById: actor.id,
      updatedById: actor.id,
    },
  });
};

const generateReturnCode = async (tx, branchCode, branchId) => {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const prefix = `RET-${branchCode}-${yyyy}${mm}${dd}-`;
  const count = await tx.returnRequest.count({
    where: {
      branchId,
      returnCode: {
        startsWith: prefix,
      },
    },
  });

  return `${prefix}${String(count + 1).padStart(4, "0")}`;
};

const generateReturnMovementCode = async (
  tx,
  branchCode,
  itemCode,
  branchId
) => {
  const prefix = `MOV-${branchCode}-${itemCode}-RETURNIN-`;
  const count = await tx.inventoryMovement.count({
    where: {
      branchId,
      movementCode: {
        startsWith: prefix,
      },
    },
  });

  return `${prefix}${String(count + 1).padStart(4, "0")}`;
};

const restoreReturnedSaleItemStock = async ({
  tx,
  actor,
  sale,
  saleItem,
  quantity,
  returnCode,
}) => {
  let batch = null;
  if (saleItem.batchId) {
    batch = await tx.inventoryBatch.findFirst({
      where: {
        id: saleItem.batchId,
        branchId: sale.branchId,
        itemId: saleItem.itemId,
      },
    });
  }

  if (!batch) {
    batch = await tx.inventoryBatch.findFirst({
      where: {
        branchId: sale.branchId,
        itemId: saleItem.itemId,
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    });
  }

  const restoreQuantity = toQuantityDecimal(quantity);
  let previousQuantity = toDecimal(0);
  let newQuantity = restoreQuantity;

  if (!batch) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const count = await tx.inventoryBatch.count({ where: { branchId: sale.branchId } });
    const autoBatchCode = `BAT-${dateStr}-${String(count + 1).padStart(4, "0")}`;

    batch = await tx.inventoryBatch.create({
      data: {
        branchId: sale.branchId,
        itemId: saleItem.itemId,
        batchCode: autoBatchCode,
        quantityIn: restoreQuantity.toFixed(2),
        quantityAvailable: restoreQuantity.toFixed(2),
        unitCost: saleItem.acquisitionUnitCostSnapshot ? saleItem.acquisitionUnitCostSnapshot.toString() : "0.00",
        operationalUnitCost: saleItem.operationalUnitCostSnapshot ? saleItem.operationalUnitCostSnapshot.toString() : "0.00",
        status: "ACTIVE",
        remarks: `Auto-generated from cancelled sale ${sale.receiptCode}`,
        createdById: actor.id,
        updatedById: actor.id,
      },
    });
  } else {
    previousQuantity = toQuantityDecimal(batch.quantityAvailable);
    newQuantity = previousQuantity.plus(restoreQuantity);

    await tx.inventoryBatch.update({
      where: {
        id: batch.id,
      },
      data: {
        quantityAvailable: newQuantity.toFixed(2),
        status: "ACTIVE",
        updatedById: actor.id,
      },
    });
  }

  if (saleItem.serialId) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "ItemSerial"
      WHERE "id" = ${saleItem.serialId}
      FOR UPDATE
    `;

    const serial = await tx.itemSerial.findFirst({
      where: {
        id: saleItem.serialId,
        branchId: sale.branchId,
        itemId: saleItem.itemId,
      },
    });

    if (serial) {
      await tx.itemSerial.update({
        where: {
          id: serial.id,
        },
        data: {
          status: "AVAILABLE",
          batchId: batch.id,
          updatedById: actor.id,
        },
      });
    }
  }

  const movementCode = await generateReturnMovementCode(
    tx,
    sale.branch.code,
    saleItem.itemCodeSnapshot || saleItem.item?.itemCode || "ITEM",
    sale.branchId
  );

  await tx.inventoryMovement.create({
    data: {
      branchId: sale.branchId,
      itemId: saleItem.itemId,
      batchId: saleItem.batchId,
      serialId: saleItem.serialId || null,
      movementCode,
      type: "RETURN_IN",
      source: "RETURN",
      quantity: restoreQuantity.toFixed(2),
      previousQuantity: previousQuantity.toFixed(2),
      newQuantity: newQuantity.toFixed(2),
      unitCost: batch.unitCost.toString(),
      referenceNo: returnCode,
      remarks: `Sale return ${returnCode} from ${sale.receiptCode}.`,
      createdById: actor.id,
      updatedById: actor.id,
    },
  });
};

const assertRefundPaymentCoverage = (sale, payload, refundAmount) => {
  const completedReturns = sale.returnRequests || [];
  const previousRefundTotal = completedReturns.reduce(
    (sum, request) => sum.plus(request.totalRefundAmount),
    toDecimal(0)
  );
  const nonCreditPaid = sale.payments
    .filter((payment) => payment.paymentMethod !== "CREDIT")
    .reduce((sum, payment) => sum.plus(payment.amount), toDecimal(0));
  const effectivePaid = Prisma.Decimal.max(
    nonCreditPaid.minus(sale.changeAmount || 0),
    toDecimal(0)
  );
  const overallRemaining = Prisma.Decimal.max(
    effectivePaid.minus(previousRefundTotal),
    toDecimal(0)
  );

  if (refundAmount.gt(overallRemaining)) {
    const error = new Error("RETURN_REFUND_EXCEEDS_PAID_AMOUNT");
    error.statusCode = 400;
    throw error;
  }

  if (payload.refundMethod === "STORE_CREDIT") {
    if (!sale.customerId) {
      const error = new Error("STORE_CREDIT_CUSTOMER_REQUIRED");
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  const paymentMethodTotal = sale.payments
    .filter((payment) => payment.paymentMethod === payload.refundMethod)
    .reduce((sum, payment) => sum.plus(payment.amount), toDecimal(0));
  const methodCollected =
    payload.refundMethod === "CASH"
      ? Prisma.Decimal.max(
          paymentMethodTotal.minus(sale.changeAmount || 0),
          toDecimal(0)
        )
      : paymentMethodTotal;
  const previousMethodRefunds = completedReturns
    .filter((request) => request.refundMethod === payload.refundMethod)
    .reduce((sum, request) => sum.plus(request.totalRefundAmount), toDecimal(0));
  const methodRemaining = Prisma.Decimal.max(
    methodCollected.minus(previousMethodRefunds),
    toDecimal(0)
  );

  if (refundAmount.gt(methodRemaining)) {
    const error = new Error("RETURN_REFUND_METHOD_EXCEEDS_PAYMENT");
    error.statusCode = 400;
    throw error;
  }
};

const createSaleReturn = async (actor, saleId, payload) => {
  if (!OWNER_ADMIN_ROLES.has(actor.role)) {
    const error = new Error("SALE_RETURN_FORBIDDEN");
    error.statusCode = 403;
    throw error;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "Sale"
      WHERE "id" = ${saleId}
      FOR UPDATE
    `;

    const sale = await tx.sale.findUnique({
      where: {
        id: saleId,
      },
      include: {
        branch: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        items: {
          orderBy: {
            lineNo: "asc",
          },
          include: {
            item: {
              select: {
                id: true,
                itemCode: true,
                itemName: true,
                isSerialized: true,
              },
            },
          },
        },
        payments: true,
        creditAccount: {
          select: {
            id: true,
            status: true,
          },
        },
        returnRequests: {
          where: {
            status: "COMPLETED",
          },
          include: {
            items: true,
          },
        },
      },
    });

    if (!sale) {
      const error = new Error("SALE_NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    ensureCanAccessSaleBranch(actor, sale);

    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(sale.status)) {
      const error = new Error("SALE_NOT_RETURNABLE");
      error.statusCode = 400;
      throw error;
    }

    if (
      sale.creditAccount ||
      sale.payments.some((payment) => payment.paymentMethod === "CREDIT")
    ) {
      const error = new Error("SALE_RETURN_CREDIT_UNSUPPORTED");
      error.statusCode = 400;
      throw error;
    }

    await tx.$queryRaw`
      SELECT "id"
      FROM "Branch"
      WHERE "id" = ${sale.branchId}
      FOR UPDATE
    `;

    const completedReturnItems = sale.returnRequests.flatMap(
      (request) => request.items
    );
    const returnedQuantityBySaleItem = new Map();
    const refundedAmountBySaleItem = new Map();

    for (const returnItem of completedReturnItems) {
      if (!returnItem.saleItemId) continue;
      returnedQuantityBySaleItem.set(
        returnItem.saleItemId,
        (returnedQuantityBySaleItem.get(returnItem.saleItemId) || toDecimal(0)).plus(
          returnItem.quantity
        )
      );
      refundedAmountBySaleItem.set(
        returnItem.saleItemId,
        (refundedAmountBySaleItem.get(returnItem.saleItemId) || toDecimal(0)).plus(
          returnItem.lineRefundAmount
        )
      );
    }

    const saleItemById = new Map(sale.items.map((saleItem) => [saleItem.id, saleItem]));
    const seenSaleItemIds = new Set();
    const preparedItems = [];
    let totalRefundAmount = toDecimal(0);

    for (let index = 0; index < payload.items.length; index += 1) {
      const requestedItem = payload.items[index];

      if (seenSaleItemIds.has(requestedItem.saleItemId)) {
        const error = new Error("DUPLICATE_RETURN_SALE_ITEM");
        error.statusCode = 400;
        throw error;
      }
      seenSaleItemIds.add(requestedItem.saleItemId);

      const saleItem = saleItemById.get(requestedItem.saleItemId);
      if (!saleItem) {
        const error = new Error("SALE_ITEM_NOT_FOUND");
        error.statusCode = 404;
        throw error;
      }

      if (!saleItem.itemId || !saleItem.batchId || !saleItem.item) {
        const error = new Error("RETURN_CUSTOM_LINE_UNSUPPORTED");
        error.statusCode = 400;
        throw error;
      }

      const requestedQuantity = toQuantityDecimal(requestedItem.quantity);
      const originalQuantity = toQuantityDecimal(saleItem.quantity);
      const alreadyReturned =
        returnedQuantityBySaleItem.get(saleItem.id) || toDecimal(0);
      const remainingQuantity = originalQuantity.minus(alreadyReturned);

      if (requestedQuantity.lte(0) || requestedQuantity.gt(remainingQuantity)) {
        const error = new Error("RETURN_QUANTITY_EXCEEDS_REMAINING");
        error.statusCode = 400;
        throw error;
      }

      if (saleItem.item.isSerialized) {
        if (
          !saleItem.serialId ||
          !requestedQuantity.eq(1) ||
          !remainingQuantity.eq(1) ||
          requestedItem.serialId !== saleItem.serialId
        ) {
          const error = new Error("SERIAL_RETURN_SELECTION_INVALID");
          error.statusCode = 400;
          throw error;
        }
      } else if (requestedItem.serialId) {
        const error = new Error("SERIAL_NOT_ALLOWED_FOR_NON_SERIALIZED_ITEM");
        error.statusCode = 400;
        throw error;
      }

      const originalLineRefund = toMoneyDecimal(saleItem.lineTotal);
      const alreadyRefunded =
        refundedAmountBySaleItem.get(saleItem.id) || toDecimal(0);
      const lineRefundAmount = requestedQuantity.eq(remainingQuantity)
        ? originalLineRefund.minus(alreadyRefunded)
        : toMoneyDecimal(
            originalLineRefund.mul(requestedQuantity).div(originalQuantity)
          );
      const safeLineRefundAmount = Prisma.Decimal.max(
        toMoneyDecimal(lineRefundAmount),
        toDecimal(0)
      );
      const unitRefundAmount = toMoneyDecimal(
        safeLineRefundAmount.div(requestedQuantity)
      );

      preparedItems.push({
        lineNo: index + 1,
        description: saleItem.description,
        reason: requestedItem.reason || payload.reason,
        quantity: requestedQuantity,
        unitRefundAmount,
        lineRefundAmount: safeLineRefundAmount,
        saleItemId: saleItem.id,
        itemId: saleItem.itemId,
        serialId: saleItem.serialId || null,
        saleItem,
      });
      totalRefundAmount = totalRefundAmount.plus(safeLineRefundAmount);
      returnedQuantityBySaleItem.set(
        saleItem.id,
        alreadyReturned.plus(requestedQuantity)
      );
      refundedAmountBySaleItem.set(
        saleItem.id,
        alreadyRefunded.plus(safeLineRefundAmount)
      );
    }

    totalRefundAmount = toMoneyDecimal(totalRefundAmount);
    const requestedRefundAmount = toMoneyDecimal(payload.refundAmount);

    if (!requestedRefundAmount.eq(totalRefundAmount)) {
      const error = new Error("RETURN_REFUND_AMOUNT_MISMATCH");
      error.statusCode = 400;
      throw error;
    }

    if (totalRefundAmount.eq(0)) {
      if (payload.refundMethod !== "NONE") {
        const error = new Error("ZERO_REFUND_REQUIRES_NONE_METHOD");
        error.statusCode = 400;
        throw error;
      }
    } else {
      if (payload.refundMethod === "NONE") {
        const error = new Error("REFUND_METHOD_REQUIRED");
        error.statusCode = 400;
        throw error;
      }
      assertRefundPaymentCoverage(sale, payload, totalRefundAmount);
    }

    const returnCode = await generateReturnCode(
      tx,
      sale.branch.code,
      sale.branchId
    );
    const completedAt = new Date();
    const returnRequest = await tx.returnRequest.create({
      data: {
        returnCode,
        status: "COMPLETED",
        reason: payload.reason,
        notes: payload.notes || null,
        internalNotes: payload.internalNotes || null,
        refundMethod: payload.refundMethod,
        totalRefundAmount: totalRefundAmount.toFixed(2),
        approvedAt: completedAt,
        completedAt,
        branchId: sale.branchId,
        customerId: sale.customerId || null,
        saleId: sale.id,
        createdById: actor.id,
        updatedById: actor.id,
        approvedById: actor.id,
        completedById: actor.id,
        items: {
          create: preparedItems.map((item) => ({
            lineNo: item.lineNo,
            description: item.description,
            reason: item.reason,
            quantity: item.quantity.toFixed(2),
            unitRefundAmount: item.unitRefundAmount.toFixed(2),
            lineRefundAmount: item.lineRefundAmount.toFixed(2),
            saleItemId: item.saleItemId,
            itemId: item.itemId,
            serialId: item.serialId,
          })),
        },
      },
      include: {
        items: {
          orderBy: {
            lineNo: "asc",
          },
          include: {
            serial: {
              select: {
                id: true,
                serialNumber: true,
                status: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
        completedBy: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    for (const item of preparedItems) {
      await restoreReturnedSaleItemStock({
        tx,
        actor,
        sale,
        saleItem: item.saleItem,
        quantity: item.quantity,
        returnCode,
      });
    }

    const inventorySaleItems = sale.items.filter((saleItem) => saleItem.itemId);
    const allInventoryItemsReturned = inventorySaleItems.every((saleItem) => {
      const returnedQuantity =
        returnedQuantityBySaleItem.get(saleItem.id) || toDecimal(0);
      return returnedQuantity.gte(saleItem.quantity);
    });
    const hasUnsupportedUnreturnedValue =
      sale.items.some((saleItem) => !saleItem.itemId) ||
      toMoneyDecimal(sale.serviceCharge).gt(0);
    const isFullyRefunded =
      inventorySaleItems.length > 0 &&
      allInventoryItemsReturned &&
      !hasUnsupportedUnreturnedValue;
    const updatedSale = await tx.sale.update({
      where: {
        id: sale.id,
      },
      data: {
        status: isFullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
        ...(isFullyRefunded ? { paymentStatus: "REFUNDED" } : {}),
        updatedById: actor.id,
      },
      select: {
        id: true,
        receiptCode: true,
        status: true,
        paymentStatus: true,
        updatedAt: true,
      },
    });

    if (payload.refundMethod === "CASH" && totalRefundAmount.gt(0)) {
      await cashLinkService.postSystemCashOut(tx, actor, sale.branch, {
        source: "SALE",
        amount: totalRefundAmount.toNumber(),
        description: `Cash refund ${returnCode} for sale ${sale.receiptCode}.`,
        referenceNo: sale.receiptCode,
        sourceId: returnRequest.id,
        sourceCode: returnCode,
        transactionDate: completedAt,
      });
    }

    const remainingProductBasis = inventorySaleItems.reduce((sum, saleItem) => {
      const refundedAmount =
        refundedAmountBySaleItem.get(saleItem.id) || toDecimal(0);
      return sum.plus(
        Prisma.Decimal.max(
          toMoneyDecimal(saleItem.lineTotal).minus(refundedAmount),
          toDecimal(0)
        )
      );
    }, toDecimal(0));

    await incentiveService.adjustSaleItemIncentiveForReturn(tx, actor, {
      saleId: sale.id,
      returnRequestId: returnRequest.id,
      remainingBasisAmount: toMoneyDecimal(remainingProductBasis),
      reason: `Sale return ${returnCode} completed: ${payload.reason}`,
    });

    await createAuditLog(
      {
        actor,
        branchId: sale.branchId,
        action: "SALE_ITEMS_RETURNED",
        entityType: "ReturnRequest",
        entityId: returnRequest.id,
        description: `${returnCode} completed for sale ${sale.receiptCode}`,
        metadata: {
          returnCode,
          saleId: sale.id,
          receiptCode: sale.receiptCode,
          refundMethod: payload.refundMethod,
          totalRefundAmount: totalRefundAmount.toFixed(2),
          resultingSaleStatus: updatedSale.status,
          items: preparedItems.map((item) => ({
            saleItemId: item.saleItemId,
            itemId: item.itemId,
            serialId: item.serialId,
            quantity: item.quantity.toFixed(2),
            lineRefundAmount: item.lineRefundAmount.toFixed(2),
          })),
        },
      },
      tx
    );

    return {
      returnRequest,
      sale: updatedSale,
    };
  });
};

const createCreditAccountFromSale = async (actor, saleId, payload) => {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "id" = ${saleId} FOR UPDATE`;

      const sale = await tx.sale.findUnique({
        where: {
          id: saleId,
        },
        include: {
          branch: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          customer: {
            select: {
              id: true,
              status: true,
            },
          },
          creditAccount: true,
        },
      });

      if (!sale) {
        const error = new Error("SALE_NOT_FOUND");
        error.statusCode = 404;
        throw error;
      }

      ensureCanAccessSaleBranch(actor, sale);

      if (sale.status !== "COMPLETED") {
        const error = new Error("SALE_NOT_CREDITABLE");
        error.statusCode = 400;
        throw error;
      }

      if (!sale.customerId || !sale.customer) {
        const error = new Error("IN_HOUSE_CUSTOMER_REQUIRED");
        error.statusCode = 400;
        throw error;
      }

      if (sale.customer.status !== "ACTIVE") {
        const error = new Error("CUSTOMER_INACTIVE");
        error.statusCode = 400;
        throw error;
      }

      if (sale.creditAccount) {
        const error = new Error("SALE_ALREADY_HAS_CREDIT_ACCOUNT");
        error.statusCode = 400;
        throw error;
      }

      await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${sale.branchId} FOR UPDATE`;

      const creditAccount = await createReceivableAccount(tx, actor, {
        branch: sale.branch,
        sourceType: "SALE",
        sourceId: sale.id,
        sourceCode: sale.receiptCode,
        sourceTotalAmount: Number(sale.grandTotal),
        initialSettlementAmount: Number(sale.amountPaid),
        customerId: sale.customerId,
        receivable: {
          provider: "IN_HOUSE_INSTALLMENT",
          term: payload.term,
          dueDay: payload.dueDay,
          firstDueDate: payload.firstDueDate,
          remarks: payload.remarks,
        },
      });

      const {
        idempotencyKey: creditIdempotencyKey,
        idempotencyFingerprint: creditIdempotencyFingerprint,
        ...safeCreditAccount
      } = creditAccount;

      return safeCreditAccount;
    });
  } catch (error) {
    if (error?.code === "P2002") {
      const duplicateError = new Error("SALE_ALREADY_HAS_CREDIT_ACCOUNT");
      duplicateError.statusCode = 400;
      throw duplicateError;
    }

    throw error;
  }
};

const SALE_CREATE_INCLUDE = {
  branch: {
    select: {
      id: true,
      code: true,
      name: true,
    },
  },
  customer: {
    select: {
      id: true,
      customerCode: true,
      fullName: true,
      mobileNumber: true,
      email: true,
    },
  },
  quotation: {
    select: SALE_QUOTATION_SELECT,
  },
  cashier: {
    select: {
      id: true,
      username: true,
      fullName: true,
      role: true,
    },
  },
  items: {
    orderBy: {
      lineNo: "asc",
    },
  },
  payments: {
    orderBy: {
      paidAt: "asc",
    },
  },
  creditAccount: true,
};

const cancelSale = async (actor, saleId, payload, database = prisma) => {
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "id" = ${saleId} FOR UPDATE`;

    const sale = await tx.sale.findUnique({
      where: {
        id: saleId,
      },
      include: {
        branch: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        items: {
          orderBy: {
            lineNo: "asc",
          },
        },
        creditAccount: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!sale) {
      const error = new Error("SALE_NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    ensureCanAccessSaleBranch(actor, sale);

    if (!OWNER_ADMIN_ROLES.has(actor.role)) {
      const error = new Error("SALE_CANCEL_FORBIDDEN");
      error.statusCode = 403;
      throw error;
    }

    if (sale.status !== "COMPLETED") {
      const error = new Error("SALE_NOT_CANCELLABLE");
      error.statusCode = 400;
      throw error;
    }

    // Resolve incentive-claim policy before reversing credit, cash, stock, or
    // sale state so a submitted/approved/paid claim can never be stranded.
    await incentiveService.assertSaleIncentivesUnclaimed(tx, sale.id);
    let reversedCollectionCount = 0;

    if (sale.creditAccount) {
      await tx.$queryRaw`SELECT "id" FROM "CreditAccount" WHERE "id" = ${sale.creditAccount.id} FOR UPDATE`;

      let creditAccount = await tx.creditAccount.findUnique({
        where: {
          id: sale.creditAccount.id,
        },
        include: {
          collections: {
            where: {
              status: "POSTED",
            },
            orderBy: {
              id: "asc",
            },
          },
        },
      });

      for (const collection of creditAccount?.collections || []) {
        await tx.$queryRaw`SELECT "id" FROM "CreditCollection" WHERE "id" = ${collection.id} FOR UPDATE`;
      }

      creditAccount = await tx.creditAccount.findUnique({
        where: {
          id: sale.creditAccount.id,
        },
        include: {
          collections: {
            where: {
              status: "POSTED",
            },
            orderBy: {
              id: "asc",
            },
          },
        },
      });
      reversedCollectionCount = creditAccount?.collections?.length || 0;

      // Keep cancellation on the same source -> AR -> collection -> branch ->
      // cash order used by collection posting/cancellation.
      await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${sale.branchId} FOR UPDATE`;

      const cancelledAt = new Date();

      for (const collection of creditAccount?.collections || []) {
        const collectionCashReversal = await cashLinkService.reverseSystemCashIn(tx, actor, {
          source: "CREDIT_COLLECTION",
          sourceId: collection.id,
          type: "CREDIT_COLLECTION",
          cancellationReason: `Auto cash reversal because sale ${sale.receiptCode} was cancelled. Reason: ${payload.cancellationReason}`,
        });

        if (collection.paymentMethod === "CASH" && !collectionCashReversal) {
          const error = new Error("COLLECTION_CASH_LINK_NOT_FOUND");
          error.statusCode = 409;
          throw error;
        }

        await tx.creditCollection.update({
          where: {
            id: collection.id,
          },
          data: {
            status: "CANCELLED",
            cancelledAt,
            cancelledById: actor.id,
            cancellationReason: `Sale ${sale.receiptCode} cancelled: ${payload.cancellationReason}`,
          },
        });
      }

      await tx.creditAccount.update({
        where: {
          id: sale.creditAccount.id,
        },
        data: {
          status: "CANCELLED",
          cancelledAt,
          cancelledById: actor.id,
          cancellationReason: `Sale ${sale.receiptCode} cancelled: ${payload.cancellationReason}`,
          updatedById: actor.id,
        },
      });
    }

    if (!sale.creditAccount) {
      await tx.$queryRaw`SELECT "id" FROM "Branch" WHERE "id" = ${sale.branchId} FOR UPDATE`;
    }

    for (const saleItem of sale.items) {
      await restoreSaleItemStock({
        tx,
        actor,
        sale,
        saleItem,
      });
    }

    const cancelledSale = await tx.sale.update({
      where: {
        id: sale.id,
      },
      data: {
        status: "CANCELLED",
        cancellationReason: payload.cancellationReason,
        cancelledAt: new Date(),
        cancelledById: actor.id,
        updatedById: actor.id,
      },
      include: {
        branch: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        customer: {
          select: {
            id: true,
            customerCode: true,
            fullName: true,
            mobileNumber: true,
            email: true,
          },
        },
        quotation: {
          select: SALE_QUOTATION_SELECT,
        },
        cashier: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
        cancelledBy: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
        items: {
          orderBy: {
            lineNo: "asc",
          },
        },
        payments: {
          orderBy: {
            paidAt: "asc",
          },
        },
      },
    });


    const reversedIncentives = await incentiveService.reverseSaleIncentives(
      tx,
      actor,
      sale.id,
      `Sale ${sale.receiptCode} cancelled: ${payload.cancellationReason}`
    );


    const cashReversal = await cashLinkService.reverseSystemCashIn(tx, actor, {
      source: "SALE",
      sourceId: sale.id,
      type: "SALE_PAYMENT",
      cancellationReason: `Auto cash reversal from cancelled sale ${sale.receiptCode}. Reason: ${payload.cancellationReason}`,
    });

    await createAuditLog(
      {
        actor,
        branchId: sale.branchId,
        action: "SALE_CANCELLED",
        entityType: "Sale",
        entityId: sale.id,
        description: `Sale ${sale.receiptCode} cancelled`,
        metadata: {
          receiptCode: sale.receiptCode,
          cancellationReason: payload.cancellationReason,
          creditAccountId: sale.creditAccount?.id || null,
          creditAccountStatus: sale.creditAccount ? "CANCELLED" : null,
          reversedCollectionCount,
          restoredStockLineCount: sale.items.length,
          cashReversed: Boolean(cashReversal),
          reversedIncentiveCount: reversedIncentives.length,
        },
      },
      tx
    );

    return sanitizeSaleCostSnapshotsForActor(cancelledSale, actor);
  });
};

const appendSaleItems = async (actor, saleId, payload, database = prisma) => {
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "id" = ${saleId} FOR UPDATE`;

    const sale = await tx.sale.findUnique({
      where: {
        id: saleId,
      },
      include: {
        ...SALE_CREATE_INCLUDE,
        items: {
          orderBy: {
            lineNo: "asc",
          },
        },
      },
    });

    if (!sale) {
      const error = new Error("SALE_NOT_FOUND");
      error.statusCode = 404;
      throw error;
    }

    if (!isSuperOwner(actor) && sale.branchId !== actor.branchId) {
      const error = new Error("BRANCH_ACCESS_DENIED");
      error.statusCode = 403;
      throw error;
    }

    if (sale.status !== "COMPLETED" && sale.status !== "PARTIALLY_REFUNDED") {
      const error = new Error("CANNOT_APPEND_TO_SALE_IN_CURRENT_STATUS");
      error.statusCode = 400;
      throw error;
    }

    const isCreditSale = Boolean(sale.creditAccount);
    const branch = sale.branch;

    const {
      saleItems: newSaleItems,
      stockDeductions,
      subtotal: addedSubtotal,
      totalDiscount: addedDiscount,
    } = await buildSaleItems(tx, actor, sale.branchId, payload.items, {
      trustedQuotation: false,
    });

    const addedGrandTotal = toMoney(addedSubtotal - addedDiscount);

    const { salePayments: newSalePayments, amountPaid: addedAmountPaid } =
      buildSalePayments(actor, payload.payments || []);

    if (!isCreditSale && addedAmountPaid < addedGrandTotal) {
      const error = new Error("INSUFFICIENT_PAYMENT_FOR_ADDED_ITEMS");
      error.statusCode = 400;
      throw error;
    }

    let addedChangeAmount = 0;
    let effectiveDownpaymentAdded = addedAmountPaid;

    if (isCreditSale) {
      if (addedAmountPaid > addedGrandTotal) {
        addedChangeAmount = toMoney(addedAmountPaid - addedGrandTotal);
        effectiveDownpaymentAdded = addedGrandTotal;
      }
    } else {
      addedChangeAmount = toMoney(
        Math.max(addedAmountPaid - addedGrandTotal, 0)
      );
    }

    const addedCashPaymentTotal = toMoney(
      newSalePayments
        .filter((payment) => payment.paymentMethod === "CASH")
        .reduce((sum, payment) => sum + Number(payment.amount), 0)
    );

    const netCashReceived = calculateNetCashReceived(
      addedCashPaymentTotal,
      addedChangeAmount
    );

    for (const deduction of stockDeductions) {
      const movementCode = await generateSaleInventoryMovementCode(
        tx,
        branch.code,
        deduction.itemCode,
        sale.branchId
      );

      await tx.inventoryMovement.create({
        data: {
          branchId: sale.branchId,
          itemId: deduction.itemId,
          batchId: deduction.batchId,
          serialId: deduction.serialId,
          movementCode,
          type: "SALE_OUT",
          source: "SALE",
          quantity: toMoneyString(deduction.quantity),
          previousQuantity: toMoneyString(deduction.previousQuantity),
          newQuantity: toMoneyString(deduction.newQuantity),
          unitCost: deduction.acquisitionUnitCost.toString(),
          referenceNo: sale.receiptCode,
          remarks: `Additional sale items for ${sale.receiptCode}.`,
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
    }

    const maxLineNo = sale.items.reduce(
      (max, item) => Math.max(max, item.lineNo || 0),
      0
    );

    for (let i = 0; i < newSaleItems.length; i++) {
      const itemData = newSaleItems[i];
      await tx.saleItem.create({
        data: {
          ...itemData,
          saleId: sale.id,
          lineNo: maxLineNo + i + 1,
        },
      });
    }

    const createdPayments = [];
    for (const paymentData of newSalePayments) {
      const createdPayment = await tx.salePayment.create({
        data: {
          ...paymentData,
          saleId: sale.id,
        },
      });
      createdPayments.push(createdPayment);
    }

    if (netCashReceived > 0) {
      const primaryCashPayment = createdPayments.find(
        (payment) => payment.paymentMethod === "CASH"
      );
      const cashSourceId = primaryCashPayment ? primaryCashPayment.id : sale.id;

      await cashLinkService.postSystemCashIn(tx, actor, branch, {
        type: "SALE_PAYMENT",
        source: "SALE",
        amount: netCashReceived,
        description: `Additional cash received from sale ${sale.receiptCode} after change.`,
        referenceNo: primaryCashPayment?.referenceNo || null,
        sourceId: cashSourceId,
        sourceCode: sale.receiptCode,
        transactionDate: new Date(),
      });
    }

    let updatedCreditAccount = null;
    if (isCreditSale) {
      updatedCreditAccount = await recalculateReceivableForSale(tx, actor, {
        creditAccountId: sale.creditAccount.id,
        addedCashPromoAmount: addedGrandTotal,
        addedDownpaymentAmount: effectiveDownpaymentAdded,
        term: payload.term || undefined,
      });
    }

    const updatedSubtotal = toMoney(Number(sale.subtotal) + addedSubtotal);
    const updatedTotalDiscount = toMoney(
      Number(sale.totalDiscount) + addedDiscount
    );
    const updatedGrandTotal = toMoney(Number(sale.grandTotal) + addedGrandTotal);
    const updatedAmountPaid = toMoney(
      Number(sale.amountPaid || 0) + (isCreditSale ? effectiveDownpaymentAdded : addedAmountPaid)
    );
    const updatedChangeAmount = toMoney(
      Number(sale.changeAmount || 0) + addedChangeAmount
    );

    let updatedPaymentStatus = sale.paymentStatus;
    if (isCreditSale && updatedCreditAccount) {
      updatedPaymentStatus = deriveSourcePaymentStatus({
        account: updatedCreditAccount,
        initialSettlementAmount: Number(updatedCreditAccount.downpaymentAmount),
      });
    } else if (!isCreditSale) {
      updatedPaymentStatus = computePaymentStatus(
        updatedAmountPaid,
        updatedGrandTotal
      );
    }

    const updatedSale = await tx.sale.update({
      where: { id: sale.id },
      data: {
        subtotal: toMoneyString(updatedSubtotal),
        totalDiscount: toMoneyString(updatedTotalDiscount),
        grandTotal: toMoneyString(updatedGrandTotal),
        amountPaid: toMoneyString(updatedAmountPaid),
        changeAmount: toMoneyString(updatedChangeAmount),
        paymentStatus: updatedPaymentStatus,
        remarks: payload.remarks
          ? `${sale.remarks || ""}; Added items: ${payload.remarks.trim()}`.trim()
          : sale.remarks,
        updatedById: actor.id,
      },
      include: SALE_CREATE_INCLUDE,
    });

    await incentiveService.postSaleIncentives(tx, actor, sale.id);

    await createAuditLog(
      {
        actor,
        branchId: sale.branchId,
        action: "SALE_ITEMS_APPENDED",
        entityType: "Sale",
        entityId: sale.id,
        description: `Added ${newSaleItems.length} item(s) to sale ${sale.receiptCode}`,
        metadata: {
          receiptCode: sale.receiptCode,
          previousGrandTotal: Number(sale.grandTotal),
          addedGrandTotal,
          newGrandTotal: updatedGrandTotal,
          addedItemCount: newSaleItems.length,
          addedPaymentCount: newSalePayments.length,
          isCreditSale,
          creditAccountId: sale.creditAccount?.id || null,
          newRemainingBalance: updatedCreditAccount
            ? updatedCreditAccount.remainingBalance.toString()
            : null,
        },
      },
      tx
    );

    return sanitizeSaleCostSnapshotsForActor(updatedSale, actor);
  });
};

module.exports = {
  createSale,
  appendSaleItems,
  createSaleReturn,
  getSales,
  getSaleById,
  createCreditAccountFromSale,
  cancelSale,
  testInternals: {
    applyMarkupToBasePrice,
    buildQuotationConversionItems,
    buildSaleItems,
    calculateNetCashReceived,
    resolveMarkupPercent,
    sanitizeSaleCostSnapshotsForActor,
  },
};
