# Pricing rules v1

Apply rules in this exact order for each order:

1. Compute `subtotal = qty * unit_price`.
2. Apply the customer-tier discount to the subtotal:
   - `gold`: 10%
   - `silver`: 5%
   - `standard`: 0%
3. If `qty >= 10`, apply an additional 5% bulk discount to the already tier-discounted amount; otherwise the bulk discount is 0%.
4. Round only the final order total to two decimal places using ordinary decimal half-up rounding.
5. There is no tax or shipping charge in this synthetic probe.

The output must preserve the original row order. Monetary columns must use exactly two decimal places.
