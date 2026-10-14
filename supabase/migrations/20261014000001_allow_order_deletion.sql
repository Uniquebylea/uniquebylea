-- 20261014000001_allow_order_deletion.sql
-- Ermöglicht dem Atelier-Admin das Löschen von Testbestellungen und bereinigt kaskadierende Fremdschlüssel.

-- 1. Trigger lockern: Nur noch UPDATE (nachträgliche Manipulation) verbieten, aber DELETE (Löschen) erlauben
DROP TRIGGER IF EXISTS order_items_no_update ON public.order_items;
CREATE TRIGGER order_items_no_update BEFORE UPDATE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_immutable();

-- 2. Bestehende Fremdschlüssel auf Kaskadierung (CASCADE) umstellen, damit beim Löschen einer Bestellung
-- automatisch alle Positionen, Status-Einträge und Benachrichtigungen sauber mitgelöscht werden.
ALTER TABLE public.order_items DROP CONSTRAINT IF EXISTS order_items_order_id_fkey,
  ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.order_status_history DROP CONSTRAINT IF EXISTS order_status_history_order_id_fkey,
  ADD CONSTRAINT order_status_history_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.email_notifications DROP CONSTRAINT IF EXISTS email_notifications_order_id_fkey,
  ADD CONSTRAINT email_notifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.voucher_redemptions DROP CONSTRAINT IF EXISTS voucher_redemptions_order_id_fkey,
  ADD CONSTRAINT voucher_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE public.payment_events DROP CONSTRAINT IF EXISTS payment_events_order_id_fkey,
  ADD CONSTRAINT payment_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

-- 3. Alle aktuellen Testbestellungen sofort sauber leeren und Zähler zurücksetzen
TRUNCATE public.order_items, public.order_status_history, public.email_notifications, public.voucher_redemptions, public.payment_events, public.orders RESTART IDENTITY CASCADE;
