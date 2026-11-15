import { type Buyer, missingInvoiceFields, parseAddressBlock, PAYMENT_METHODS, regionForCountry, type Sale, type SaleRegion, type StockItem, ymd } from "@homebase/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";

// Logging a sale, built to take seconds:
//   - an item is entered once, when it is bought; selling it is one click
//   - the buyer's address is pasted as a block and split into fields
//   - the invoice number is the next free one
//   - the form says what an invoice still needs, and "Complete" stays off
//     until nothing is missing (the core enforces the same rule)

type Form = {
  id: string;
  date: string;
  desc: string;
  amount: string;
  cost: string;
  ship: string;
  other: string;
  region: SaleRegion;
  method: string;
  inv: string;
  stockItemId: string;
  buyerId: string;
  name: string;
  email: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
};

const emptyForm = (inv: string): Form => ({
  id: "", date: ymd(new Date()), desc: "", amount: "", cost: "", ship: "", other: "", region: "NL", method: "Website", inv,
  stockItemId: "", buyerId: "", name: "", email: "", street: "", postalCode: "", city: "", country: "",
});

const number = (text: string) => (text.trim() === "" ? null : Number(text.replace(",", ".")));
const euro = (amount: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(amount);
const input = "w-full rounded-md border border-line bg-ink px-3 py-2 text-sm text-bone outline-none focus:border-salmon/60";

export function SalesScreen({ onBack }: { onBack: () => void }) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [nextInvoice, setNextInvoice] = useState("");
  const [form, setForm] = useState<Form>(emptyForm(""));
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [newStock, setNewStock] = useState({ desc: "", cost: "", date: ymd(new Date()), source: "" });

  const set = (changes: Partial<Form>) => setForm((current) => ({ ...current, ...changes }));

  const load = useCallback(async () => {
    const [saleList, stockList, buyerList, next] = await Promise.all([
      api<Sale[]>("GET", "/api/sales"),
      api<StockItem[]>("GET", "/api/stock"),
      api<Buyer[]>("GET", "/api/buyers"),
      api<{ invoice: string }>("GET", "/api/sales/next-invoice"),
    ]);
    setSales(saleList);
    setStock(stockList);
    setBuyers(buyerList);
    setNextInvoice(next.invoice);
    return next.invoice;
  }, []);

  useEffect(() => {
    load()
      .then((invoice) => setForm(emptyForm(invoice)))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "The core is not answering."));
  }, [load]);

  const buyer = form.name.trim() ? { id: form.buyerId, name: form.name, email: form.email, street: form.street, postalCode: form.postalCode, city: form.city, country: form.country } : null;
  const amount = number(form.amount);
  const cost = number(form.cost);
  // The same function the core uses to decide whether a sale is complete.
  const missing = missingInvoiceFields({ date: form.date, desc: form.desc, amount: amount ?? 0, cost, inv: form.inv, buyer });
  const started = Boolean(form.desc.trim() || form.amount.trim() || form.name.trim());
  const margin = amount !== null && cost !== null ? amount - cost - (number(form.ship) ?? 0) - (number(form.other) ?? 0) : null;

  /** Splits a pasted address into fields. A best guess: the fields stay editable. */
  const applyAddress = (text: string) => {
    setPasted(text);
    if (!text.trim()) return;
    const parsed = parseAddressBlock(text);
    const region = regionForCountry(parsed.country);
    const known = buyers.find((other) => other.name.toLowerCase() === parsed.name.toLowerCase() && other.postalCode.toLowerCase() === parsed.postalCode.toLowerCase());
    set({ ...parsed, buyerId: known?.id ?? "", ...(region ? { region } : {}) });
  };

  const pickStock = (item: StockItem) => set({ stockItemId: item.id, desc: item.desc, cost: String(item.cost) });

  const edit = (sale: Sale) => {
    const known = buyers.find((other) => other.id === sale.buyerId);
    setPasted("");
    setSaved("");
    setForm({
      id: sale.id, date: sale.date, desc: sale.desc, amount: String(sale.amount), cost: sale.cost === null ? "" : String(sale.cost), ship: sale.ship ? String(sale.ship) : "",
      other: sale.other ? String(sale.other) : "", region: sale.region, method: sale.method, inv: sale.inv || nextInvoice, stockItemId: sale.stockItemId,
      buyerId: known?.id ?? "", name: known?.name ?? "", email: known?.email ?? "", street: known?.street ?? "", postalCode: known?.postalCode ?? "", city: known?.city ?? "", country: known?.country ?? "",
    });
  };

  const save = async (status: "draft" | "complete") => {
    setError("");
    setSaved("");
    const body = {
      date: form.date, desc: form.desc, amount: amount ?? 0, cost, ship: number(form.ship) ?? 0, other: number(form.other) ?? 0, region: form.region, method: form.method,
      // A draft does not use up an invoice number.
      inv: status === "complete" ? form.inv : "", status, stockItemId: form.stockItemId, buyer,
    };
    try {
      await api(form.id ? "PUT" : "POST", form.id ? `/api/sales/${form.id}` : "/api/sales", body);
      setSaved(status === "complete" ? `Sale ${form.inv} is complete.` : "Draft saved.");
      setPasted("");
      setForm(emptyForm(await load()));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
    }
  };

  const addStock = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api("POST", "/api/stock", { desc: newStock.desc, cost: number(newStock.cost) ?? 0, date: newStock.date, source: newStock.source });
      setNewStock({ desc: "", cost: "", date: ymd(new Date()), source: "" });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
    }
  };

  const field = (label: string, key: keyof Form, extra: { type?: string; placeholder?: string } = {}) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className={`${input} mt-1`} value={form[key]} onChange={(event) => set({ [key]: event.target.value })} {...extra} />
    </label>
  );

  const inStock = stock.filter((item) => !item.saleId);

  return (
    <div className="h-full overflow-y-auto bg-void px-[4vw] py-[4vh]">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="label">Home Base</p>
          <h1 className="text-3xl font-light">Sales</h1>
        </div>
        <button type="button" onClick={onBack} className="text-xs tracking-widest text-mute uppercase hover:text-bone">
          Back to the main screen
        </button>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section aria-label={form.id ? "Edit sale" : "New sale"} className="space-y-4">
          <p className="label">{form.id ? "Editing a sale" : "New sale"}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">{field("Item", "desc", { placeholder: "Pick from stock on the right, or type" })}</div>
            {field("Sold for", "amount", { placeholder: "0.00" })}
            {field("Bought for", "cost", { placeholder: "0.00" })}
            {field("Shipping you paid", "ship", { placeholder: "0.00" })}
            {field("Other costs", "other", { placeholder: "0.00" })}
            {field("Date", "date", { type: "date" })}
            {field("Invoice number", "inv")}
            <label className="block">
              <span className="label">Paid through</span>
              <select className={`${input} mt-1`} value={form.method} onChange={(event) => set({ method: event.target.value })}>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Buyer is in</span>
              <select className={`${input} mt-1`} value={form.region} onChange={(event) => set({ region: event.target.value as SaleRegion })}>
                <option value="NL">Netherlands</option>
                <option value="EU">Rest of the EU</option>
                <option value="world">Outside the EU</option>
              </select>
            </label>
          </div>

          <label className="block">
            <span className="label">Paste the buyer's address</span>
            <textarea className={`${input} mt-1 h-24 resize-none`} value={pasted} onChange={(event) => applyAddress(event.target.value)} placeholder={"Name\nStreet 12\n1234 AB City\nCountry"} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            {field("Buyer name", "name")}
            {field("Email", "email")}
            <div className="col-span-2">{field("Street", "street")}</div>
            {field("Postal code", "postalCode")}
            {field("City", "city")}
            {field("Country", "country")}
          </div>

          <div aria-live="polite" className="text-sm">
            {/* An untouched form is not "missing" anything yet. */}
            {started && (missing.length > 0 ? <p className="text-salmon/90">Still missing for an invoice: {missing.join(", ")}.</p> : <p className="text-soft">Everything an invoice needs is here.</p>)}
            {margin !== null && <p className="mt-1 text-mute">Margin on this sale: {euro(margin)}</p>}
            {error && (
              <p role="alert" className="mt-1 text-salmon">
                {error}
              </p>
            )}
            {saved && <p className="mt-1 text-bone">{saved}</p>}
          </div>

          <div className="flex gap-3">
            <button type="button" disabled={missing.length > 0} onClick={() => save("complete")} className="rounded-md bg-bone px-5 py-2 text-sm font-medium text-void hover:bg-white disabled:opacity-40">
              Complete sale
            </button>
            <button type="button" disabled={!form.desc.trim() || amount === null} onClick={() => save("draft")} className="rounded-md border border-line px-5 py-2 text-sm text-soft hover:border-mute disabled:opacity-40">
              Save as draft
            </button>
            {form.id && (
              <button type="button" onClick={() => setForm(emptyForm(nextInvoice))} className="px-2 text-sm text-mute hover:text-bone">
                Cancel
              </button>
            )}
          </div>
        </section>

        <section className="space-y-8">
          <div>
            <p className="label">In stock · {inStock.length}</p>
            <ul className="mt-2 divide-y divide-line">
              {inStock.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => pickStock(item)} className={`flex w-full items-baseline justify-between gap-3 py-2 text-left text-sm hover:text-bone ${form.stockItemId === item.id ? "text-salmon" : "text-soft"}`}>
                    <span className="truncate">{item.desc}</span>
                    <span className="shrink-0 text-mute tabular-nums">{euro(item.cost)}</span>
                  </button>
                </li>
              ))}
              {inStock.length === 0 && <li className="py-2 text-sm text-mute">Nothing in stock. Add items when you buy them.</li>}
            </ul>
            <form onSubmit={addStock} className="mt-3 grid grid-cols-[1fr_6rem_auto] gap-2">
              <input className={input} value={newStock.desc} onChange={(event) => setNewStock({ ...newStock, desc: event.target.value })} placeholder="Bought: item" aria-label="New stock item" required />
              <input className={input} value={newStock.cost} onChange={(event) => setNewStock({ ...newStock, cost: event.target.value })} placeholder="Paid" aria-label="Purchase price" required />
              <button type="submit" className="rounded-md border border-line px-3 text-sm text-soft hover:border-mute">
                Add
              </button>
            </form>
          </div>

          <div>
            <p className="label">Sales · {sales.length}</p>
            <ul className="mt-2 divide-y divide-line">
              {sales.slice(0, 30).map((sale) => (
                <li key={sale.id}>
                  <button type="button" onClick={() => edit(sale)} className="grid w-full grid-cols-[5.5rem_1fr_auto] items-baseline gap-3 py-2 text-left text-sm text-soft hover:text-bone">
                    <span className="text-mute tabular-nums">{sale.date}</span>
                    <span className="truncate">{sale.desc}</span>
                    <span className="tabular-nums">
                      {euro(sale.amount)} <span className={sale.status === "draft" ? "text-salmon" : "text-mute"}>{sale.status === "draft" ? "draft" : sale.inv}</span>
                    </span>
                  </button>
                </li>
              ))}
              {sales.length === 0 && <li className="py-2 text-sm text-mute">No sales logged yet.</li>}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
