import { z } from 'zod';

const metadataSchema = z.record(z.string(), z.unknown());
const probabilityPriceSchema = z.number().min(0).max(1).finite();
const quantitySchema = z.number().positive().finite();
const nonNegativeNumberSchema = z.number().nonnegative().finite();
const signedNumberSchema = z.number().finite();

export const executionModeSchema = z.enum(['simulation', 'paper', 'live']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const tradeSideSchema = z.enum(['buy', 'sell']);
export type TradeSide = z.infer<typeof tradeSideSchema>;

export const orderStatusSchema = z.enum([
  'pending-submit',
  'pending-ack',
  'open',
  'partially-filled',
  'filled',
  'cancel-pending',
  'canceled',
  'rejected',
  'reconcile'
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const liquidityRoleSchema = z.enum(['maker', 'taker']);
export type LiquidityRole = z.infer<typeof liquidityRoleSchema>;

export const positionTransitionSchema = z.enum(['opened', 'increased', 'reduced', 'closed']);
export type PositionTransition = z.infer<typeof positionTransitionSchema>;

export const approvedTradeIntentSchema = z.object({
  sessionId: z.string().min(1),
  intentId: z.string().min(1),
  strategyId: z.string().min(1),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  side: tradeSideSchema,
  limitPrice: probabilityPriceSchema,
  quantity: quantitySchema,
  reduceOnly: z.boolean().optional(),
  approvedAt: z.string().min(1).optional(),
  thesis: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: metadataSchema.optional()
});
export type ApprovedTradeIntent = z.infer<typeof approvedTradeIntentSchema>;

export const paperQuoteSchema = z.object({
  quoteId: z.string().min(1).optional(),
  marketId: z.string().min(1),
  tokenId: z.string().min(1),
  observedAt: z.string().min(1),
  bestBid: probabilityPriceSchema.nullable(),
  bidSize: nonNegativeNumberSchema.optional(),
  bestAsk: probabilityPriceSchema.nullable(),
  askSize: nonNegativeNumberSchema.optional(),
  midpoint: probabilityPriceSchema.nullable().optional(),
  source: z.string().min(1).optional(),
  metadata: metadataSchema.optional()
});
export type PaperQuote = z.infer<typeof paperQuoteSchema>;

const eventBaseSchema = z.object({
  eventId: z.string().min(1),
  recordedAt: z.string().min(1),
  sessionId: z.string().min(1),
  executionMode: executionModeSchema,
  marketId: z.string().min(1),
  tokenId: z.string().min(1)
});

export const intentApprovedEventSchema = eventBaseSchema.extend({
  kind: z.literal('intent.approved'),
  intentId: z.string().min(1),
  strategyId: z.string().min(1),
  side: tradeSideSchema,
  limitPrice: probabilityPriceSchema,
  quantity: quantitySchema,
  reduceOnly: z.boolean().optional(),
  thesis: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: metadataSchema.optional()
});
export type IntentApprovedEvent = z.infer<typeof intentApprovedEventSchema>;

export const orderUpdatedEventSchema = eventBaseSchema.extend({
  kind: z.literal('order.updated'),
  intentId: z.string().min(1),
  orderId: z.string().min(1),
  side: tradeSideSchema,
  limitPrice: probabilityPriceSchema,
  requestedQuantity: quantitySchema,
  filledQuantity: nonNegativeNumberSchema,
  remainingQuantity: nonNegativeNumberSchema,
  status: orderStatusSchema,
  rejectionReason: z.string().min(1).nullable().optional(),
  venueOrderId: z.string().min(1).nullable().optional(),
  venueStatus: z.string().min(1).nullable().optional(),
  acknowledgedAt: z.string().min(1).nullable().optional(),
  lastReconciledAt: z.string().min(1).nullable().optional(),
  statusReason: z.string().min(1).nullable().optional(),
  quoteId: z.string().min(1).nullable().optional(),
  referenceBid: probabilityPriceSchema.nullable().optional(),
  referenceAsk: probabilityPriceSchema.nullable().optional(),
  metadata: metadataSchema.optional()
});
export type OrderUpdatedEvent = z.infer<typeof orderUpdatedEventSchema>;

export const fillRecordedEventSchema = eventBaseSchema.extend({
  kind: z.literal('fill.recorded'),
  intentId: z.string().min(1),
  orderId: z.string().min(1),
  fillId: z.string().min(1),
  side: tradeSideSchema,
  price: probabilityPriceSchema,
  quantity: quantitySchema,
  fee: nonNegativeNumberSchema,
  notional: nonNegativeNumberSchema,
  liquidityRole: liquidityRoleSchema,
  venueFillId: z.string().min(1).nullable().optional(),
  exchangeTimestamp: z.string().min(1).nullable().optional(),
  quoteId: z.string().min(1).nullable().optional(),
  referenceBid: probabilityPriceSchema.nullable().optional(),
  referenceAsk: probabilityPriceSchema.nullable().optional(),
  metadata: metadataSchema.optional()
});
export type FillRecordedEvent = z.infer<typeof fillRecordedEventSchema>;

export const positionUpdatedEventSchema = eventBaseSchema.extend({
  kind: z.literal('position.updated'),
  positionId: z.string().min(1),
  fillId: z.string().min(1),
  transition: positionTransitionSchema,
  quantityDelta: signedNumberSchema,
  netQuantity: nonNegativeNumberSchema,
  averageEntryPrice: nonNegativeNumberSchema.nullable(),
  realizedPnlDelta: signedNumberSchema,
  realizedPnlTotal: signedNumberSchema,
  openedLotIds: z.array(z.string().min(1)),
  closedLotIds: z.array(z.string().min(1))
});
export type PositionUpdatedEvent = z.infer<typeof positionUpdatedEventSchema>;

export const operatorActionSchema = z.enum(['flatten-requested', 'kill-switch-engaged', 'kill-switch-released']);
export type OperatorAction = z.infer<typeof operatorActionSchema>;

export const operatorActionEventSchema = z.object({
  kind: z.literal('operator.action'),
  eventId: z.string().min(1),
  recordedAt: z.string().min(1),
  sessionId: z.string().min(1),
  executionMode: executionModeSchema,
  marketId: z.string().min(1).nullable().optional(),
  tokenId: z.string().min(1).nullable().optional(),
  action: operatorActionSchema,
  targetOrderId: z.string().min(1).nullable().optional(),
  targetPositionId: z.string().min(1).nullable().optional(),
  note: z.string().min(1).nullable().optional(),
  metadata: metadataSchema.optional()
});
export type OperatorActionEvent = z.infer<typeof operatorActionEventSchema>;

export const paperLedgerEventSchema = z.union([
  intentApprovedEventSchema,
  orderUpdatedEventSchema,
  fillRecordedEventSchema,
  positionUpdatedEventSchema,
  operatorActionEventSchema
]);
export type PaperLedgerEvent = z.infer<typeof paperLedgerEventSchema>;

export const ledgerEnvelopeSchema = z.object({
  sequence: z.number().int().positive(),
  appendedAt: z.string().min(1),
  event: paperLedgerEventSchema
});
export type LedgerEnvelope = z.infer<typeof ledgerEnvelopeSchema>;
