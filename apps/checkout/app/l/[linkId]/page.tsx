"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";
import { usePaymentLink } from "@/hooks/usePaymentLink";
import { api } from "@/lib/api";
import { MerchantBranding } from "@/components/MerchantBranding";
import { LinkCard } from "@/components/LinkCard";
import { LinkError } from "@/components/LinkError";
import { TrustBadges } from "@/components/TrustBadges";

export default function PaymentLinkPage({
  params,
}: {
  params: Promise<{ linkId: string }>;
}) {
  const { linkId } = use(params);
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: link, isLoading, error } = usePaymentLink(linkId);

  const handleSubmit = async (amount?: number) => {
    setIsSubmitting(true);
    try {
      const payment = await api.post<{ id: string }>("/v1/payments", {
        linkId,
        amount,
      });
      router.push(`/${payment.id}`);
    } catch (err) {
      console.error("Failed to create payment:", err);
      setIsSubmitting(false);
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen justify-center bg-muted/30 px-4 py-8 sm:px-8">
        <div className="w-full max-w-[460px] space-y-6">
          {/* Merchant branding skeleton */}
          <div className="text-center">
            <div className="mx-auto h-10 w-10 skeleton rounded-lg" />
            <div className="mx-auto mt-2 h-4 w-32 skeleton" />
          </div>

          {/* Link card skeleton */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="space-y-4">
              <div>
                <div className="h-5 w-40 skeleton" />
                <div className="mt-1 h-4 w-24 skeleton" />
              </div>

              <div className="border-t border-border pt-4">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Amount</span>
                  <span className="skeleton h-6 w-24" />
                </div>
              </div>

              <button className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground opacity-50">
                Loading...
              </button>
            </div>
          </div>

          <TrustBadges />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    const axiosError = error as { response?: { status?: number } };
    const status = axiosError.response?.status;

    if (status === 404) {
      return <LinkError type="not-found" />;
    }

    return <LinkError type="not-found" />;
  }

  // Link validation
  if (!link.active) {
    return <LinkError type="inactive" />;
  }

  if (link.redeemed) {
    return <LinkError type="redeemed" />;
  }

  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return <LinkError type="expired" expiresAt={link.expiresAt} />;
  }

  // Main content
  return (
    <div className="flex min-h-screen justify-center bg-muted/30 px-4 py-8 sm:px-8">
      <div className="w-full max-w-[460px] space-y-6">
        <MerchantBranding
          merchantName={link.merchantName}
          merchantLogo={link.merchantLogo}
        />

        <LinkCard
          link={link}
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
        />

        <TrustBadges />
      </div>
    </div>
  );
}
