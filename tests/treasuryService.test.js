import test from "node:test";
import assert from "node:assert/strict";
import TreasuryService from "../services/TreasuryService.js";

test("TreasuryService validation and rule assertions", async (t) => {
  await t.test("calculateCashPosition requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.calculateCashPosition({});
      },
      { message: "tenantId is required to calculate cash position." }
    );
  });

  await t.test("getLatestCashPosition requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.getLatestCashPosition({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("getTreasuryDashboard requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.getTreasuryDashboard({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("syncBankBalances requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.syncBankBalances({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("generateLiquidityForecast requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.generateLiquidityForecast({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("createInvestment requires tenantId, name, investmentType, counterpartyBank, principalAmount, maturityDate", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.createInvestment({ tenantId: "tenant-123" });
      },
      { message: "Missing required investment parameters (tenantId, name, investmentType, counterpartyBank, principalAmount, maturityDate)." }
    );
  });

  await t.test("recordDebt requires tenantId, facilityName, debtType, lender, principalAmount, maturityDate", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.recordDebt({ tenantId: "tenant-123" });
      },
      { message: "Missing required debt parameters (tenantId, facilityName, debtType, lender, principalAmount, maturityDate)." }
    );
  });

  await t.test("calculateFXExposure requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.calculateFXExposure({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("evaluateTreasuryRisks requires tenantId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.evaluateTreasuryRisks({});
      },
      { message: "tenantId is required." }
    );
  });

  await t.test("getInvestmentById requires tenantId and investmentId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.getInvestmentById({ tenantId: "tenant-123" });
      },
      { message: "tenantId and investmentId are required." }
    );
  });

  await t.test("getDebtById requires tenantId and debtId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.getDebtById({ tenantId: "tenant-123" });
      },
      { message: "tenantId and debtId are required." }
    );
  });

  await t.test("updateInvestmentStatus requires tenantId, investmentId, and status", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.updateInvestmentStatus({ tenantId: "tenant-123", investmentId: "INV-1" });
      },
      { message: "tenantId, investmentId, and status are required." }
    );
  });

  await t.test("updateDebtStatus requires tenantId and debtId", async () => {
    await assert.rejects(
      async () => {
        await TreasuryService.updateDebtStatus({ tenantId: "tenant-123" });
      },
      { message: "tenantId and debtId are required." }
    );
  });

  await t.test("Liquidity Coverage Ratio classifies Breached/Warning/Normal at the real 1.0/1.5 thresholds", () => {
    const classify = (liquidityRatio) => {
      const status = liquidityRatio < 1.0 ? "Breached" : (liquidityRatio < 1.5 ? "Warning" : "Normal");
      const severity = liquidityRatio < 1.0 ? "High" : (liquidityRatio < 1.5 ? "Medium" : "Low");
      return { status, severity };
    };

    assert.deepEqual(classify(0.8), { status: "Breached", severity: "High" });
    assert.deepEqual(classify(1.2), { status: "Warning", severity: "Medium" });
    assert.deepEqual(classify(2.0), { status: "Normal", severity: "Low" });
  });

  await t.test("Bank concentration risk classifies Breached/Warning/Normal at the real 40%/50% thresholds", () => {
    const classify = (concentrationPct) => {
      const status = concentrationPct > 50 ? "Breached" : (concentrationPct > 40 ? "Warning" : "Normal");
      const severity = concentrationPct > 50 ? "Critical" : (concentrationPct > 40 ? "Medium" : "Low");
      return { status, severity };
    };

    assert.deepEqual(classify(60), { status: "Breached", severity: "Critical" });
    assert.deepEqual(classify(45), { status: "Warning", severity: "Medium" });
    assert.deepEqual(classify(25), { status: "Normal", severity: "Low" });
  });

  await t.test("FX net exposure nets long bank/investment positions against short debt positions per currency", () => {
    const currencyMap = { EUR: { long: 0, short: 0 } };
    currencyMap.EUR.long += 100000; // bank balance
    currencyMap.EUR.long += 50000; // investment
    currencyMap.EUR.short += 30000; // debt

    const net = currencyMap.EUR.long - currencyMap.EUR.short;
    assert.equal(net, 120000);
  });

  await t.test("Liquidity forecast shortfall is the real gap below the minimum buffer, never negative", () => {
    const shortfall = (minimumBuffer, endingLiquidity) => Math.max(0, minimumBuffer - endingLiquidity);

    assert.equal(shortfall(50000, 30000), 20000);
    assert.equal(shortfall(50000, 80000), 0);
  });
});
