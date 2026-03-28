interface MerchantBrandingProps {
  name?: string;
  logo?: string;
}

export function MerchantBranding({ name, logo }: MerchantBrandingProps) {
  return (
    <div className="text-center">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={name ?? "Merchant logo"}
          width={40}
          height={40}
          className="mx-auto rounded-lg object-contain"
        />
      ) : (
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <span className="font-display text-sm font-bold">
            {name ? name[0].toUpperCase() : "T"}
          </span>
        </div>
      )}
      <p className="mt-2 font-display text-sm font-semibold text-foreground">
        {name ?? "Tavvio"}
      </p>
    </div>
  );
}
