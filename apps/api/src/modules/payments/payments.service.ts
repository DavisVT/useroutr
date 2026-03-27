import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus, Payment } from '../../generated/prisma';
import { EventsGateway } from '../events/events/events.gateway';
import { QuotesService } from '../quotes/quotes.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { StellarService } from '../stellar/stellar.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentFiltersDto } from './dto/payment-filters.dto';
import * as crypto from 'crypto';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly CHECKOUT_URL = process.env.CHECKOUT_URL || 'https://checkout.useroutr.io';

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly quotesService: QuotesService,
    private readonly webhooksService: WebhooksService,
    private readonly stellarService: StellarService,
  ) {}

  async create(merchantId: string, dto: CreatePaymentDto): Promise<any> {
    this.logger.log(`Creating payment for merchant ${merchantId} with quote ${dto.quoteId}`);

    // Fetch merchant to get settlement preferences
    const merchant = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');

    // 1. Validate and consume quote
    const quote = await this.quotesService.validateAndConsume(dto.quoteId);

    // 2. Generate HTLC secret + hashlock
    const secret = crypto.randomBytes(32);
    const hashlock = crypto.createHash('sha256').update(secret).digest('hex');

    // 3. Create payment record (status: PENDING)
    const payment = await this.prisma.payment.create({
      data: {
        merchantId,
        quoteId: quote.id,
        status: PaymentStatus.PENDING,
        sourceChain: quote.fromChain,
        sourceAsset: quote.fromAsset,
        sourceAmount: quote.fromAmount,
        destChain: quote.toChain,
        destAsset: quote.toAsset,
        destAmount: quote.toAmount,
        destAddress: merchant.settlementAddress || 'system_vault', // fallback
        hashlock,
        metadata: (dto.metadata as any) || {},
      },
    });

    // 4. Return payment with checkout URL
    return {
      id: payment.id,
      status: payment.status.toLowerCase(),
      checkout_url: `${this.CHECKOUT_URL}/pay/${payment.id}`,
      amount: Number(payment.sourceAmount),
      currency: payment.sourceAsset,
      settlement_amount: payment.destAmount.toString(),
      settlement_asset: payment.destAsset,
      customer: dto.customer,
      metadata: payment.metadata,
      created_at: payment.createdAt,
      expires_at: new Date(payment.createdAt.getTime() + 30 * 60 * 1000), // 30 min expiry
    };
  }

  async updateStatus(paymentId: string, status: PaymentStatus, extra?: Partial<Payment>): Promise<Payment> {
    this.logger.log(`Updating payment ${paymentId} status to ${status}`);

    const payment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status,
        ...extra,
        ...(status === PaymentStatus.COMPLETED ? { completedAt: new Date() } : {}),
      },
    });

    // Emit WebSocket event
    if (this.eventsGateway.server) {
        this.eventsGateway.server.to(payment.id).emit('payment.updated', payment);
    }

    // Dispatch webhook
    await this.webhooksService.dispatch(
      payment.merchantId,
      `payment.${status.toLowerCase()}`,
      payment,
      payment.id
    );

    return payment;
  }

  async getById(paymentId: string): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { merchant: true, quote: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async getByMerchant(merchantId: string, filters: PaymentFiltersDto) {
    const { page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc', status, search } = filters;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { merchantId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { id: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    };
  }

  async findByStellarLockId(lockId: string) {
    return this.prisma.payment.findFirst({
      where: { stellarLockId: lockId },
    });
  }

  async findBySourceLockId(lockId: string) {
    return this.prisma.payment.findFirst({
      where: { sourceLockId: lockId },
    });
  }

  async findExpiredPending() {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    return this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        createdAt: { lt: thirtyMinAgo },
      },
    });
  }

  async handleSourceLock(paymentId: string, sourceTxHash: string, sourceLockId: string) {
    const payment = await this.getById(paymentId);
    if (payment.status !== PaymentStatus.PENDING) return;

    await this.updateStatus(paymentId, PaymentStatus.SOURCE_LOCKED, {
      sourceTxHash,
      sourceLockId,
    });

    // Trigger Stellar lock
    await this.lockOnStellar(paymentId);
  }

  async lockOnStellar(paymentId: string) {
    const payment = await this.getById(paymentId);
    
    try {
        const stellarTxHash = await this.stellarService.lockHTLC({
            sender: 'vault_address',
            receiver: payment.destAddress,
            token: payment.destAsset,
            amount: BigInt(Math.floor(Number(payment.destAmount))), // Simplified
            hashlock: payment.hashlock!,
            timelock: Math.floor(Date.now() / 1000) + 3600,
        });

        await this.updateStatus(paymentId, PaymentStatus.STELLAR_LOCKED, {
            stellarTxHash,
        });
    } catch (err) {
        this.logger.error(`Stellar lock failed for payment ${paymentId}: ${err.message}`);
        await this.updateStatus(paymentId, PaymentStatus.FAILED);
    }
  }

  async notifyCompletion(paymentId: string) {
    await this.updateStatus(paymentId, PaymentStatus.COMPLETED);
  }

  async initiateRefund(paymentId: string) {
    return this.updateStatus(paymentId, PaymentStatus.REFUNDING);
  }

  async exportTransactions(merchantId: string, filters: PaymentFiltersDto): Promise<Buffer> {
    const { items } = await this.getByMerchant(merchantId, { ...filters, limit: 1000 });
    const header = 'id,amount,currency,status,createdAt\n';
    const rows = items.map(p => `${p.id},${p.sourceAmount},${p.sourceAsset},${p.status},${p.createdAt.toISOString()}`).join('\n');
    return Buffer.from(header + rows);
  }
}
