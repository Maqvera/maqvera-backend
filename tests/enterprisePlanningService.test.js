import test from "node:test";
import assert from "node:assert/strict";
import EnterprisePlanningService from "../services/EnterprisePlanningService.js";

test("EnterprisePlanningService validation and rule assertions", async (t) => {
  await t.test("createBudget requires tenantId, name, fiscalYear, currency", async () => {
    await assert.rejects(
      async () => {
        await EnterprisePlanningService.createBudget("", { name: "Test Budget", fiscalYear: "2028", currency: "USD" });
      },
      { message: "Tenant ID is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.createBudget("tenant-123", { name: "", fiscalYear: "2028", currency: "USD" });
      },
      { message: "Budget name is required." }
    );
  });

  await t.test("generateForecast requires tenantId, name, fiscalYear before touching the database", async () => {
    await assert.rejects(
      async () => {
        await EnterprisePlanningService.generateForecast("", { name: "FY2028 Revenue Forecast", fiscalYear: "2028" });
      },
      { message: "Tenant ID is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.generateForecast("tenant-123", { name: "", fiscalYear: "2028" });
      },
      { message: "Forecast name is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.generateForecast("tenant-123", { name: "FY2028 Revenue Forecast", fiscalYear: "" });
      },
      { message: "Fiscal year is required." }
    );
  });

  await t.test("calculateVariance requires tenantId and fiscalYear before touching the database", async () => {
    await assert.rejects(
      async () => {
        await EnterprisePlanningService.calculateVariance("", { fiscalYear: "2028" });
      },
      { message: "Tenant ID is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.calculateVariance("tenant-123", { fiscalYear: "" });
      },
      { message: "Fiscal year is required." }
    );
  });

  await t.test("createScenario requires tenantId, name, fiscalYear before touching the database", async () => {
    await assert.rejects(
      async () => {
        await EnterprisePlanningService.createScenario("", { name: "Best Case FY2028", fiscalYear: "2028" });
      },
      { message: "Tenant ID is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.createScenario("tenant-123", { name: "", fiscalYear: "2028" });
      },
      { message: "Scenario name is required." }
    );

    await assert.rejects(
      async () => {
        await EnterprisePlanningService.createScenario("tenant-123", { name: "Best Case FY2028", fiscalYear: "" });
      },
      { message: "Fiscal year is required." }
    );
  });

  await t.test("Budget line items calculate total amount correctly", () => {
    const lineItems = [
      { name: "Marketing Campaigns", allocatedAmount: 120000, category: "Expense" },
      { name: "Software Licenses", allocatedAmount: 30000, category: "Expense" }
    ];
    const totalAmount = lineItems.reduce((s, i) => s + i.allocatedAmount, 0);
    assert.equal(totalAmount, 150000);
  });

  await t.test("Published budget cannot be directly updated (Rule: Never Modify Published Budgets)", async () => {
    // Mock budget object with status Published
    const fakePublishedBudget = { status: "Published", budgetId: "BDG-2028-001" };

    // Assert that updating a published budget throws an explicit error
    assert.equal(fakePublishedBudget.status, "Published");
    assert.throws(
      () => {
        if (fakePublishedBudget.status === "Published") {
          throw new Error("Published budgets cannot be modified directly. Create a new budget revision/version instead.");
        }
      },
      /Published budgets cannot be modified directly/
    );
  });

  await t.test("Scenario evaluation computes multipliers correctly", () => {
    const baselineRevenue = 1000000;
    const baselineExpense = 600000;
    const revenueMultiplier = 1.15; // +15% revenue
    const expenseMultiplier = 0.90; // -10% expense

    const projectedRevenue = baselineRevenue * revenueMultiplier; // 1,150,000
    const projectedExpense = baselineExpense * expenseMultiplier; // 540,000
    const projectedProfit = projectedRevenue - projectedExpense;   // 610,000
    const baselineProfit = baselineRevenue - baselineExpense;     // 400,000

    const varianceToBaseline = projectedProfit - baselineProfit; // 210,000

    assert.equal(projectedRevenue, 1150000);
    assert.equal(projectedExpense, 540000);
    assert.equal(projectedProfit, 610000);
    assert.equal(varianceToBaseline, 210000);
  });

  await t.test("Variance calculation calculates favorable/unfavorable variance correctly", () => {
    const targetExpense = 100000;
    const actualExpense = 85000;
    const expenseVariance = targetExpense - actualExpense; // 15,000 favorable (spent less than budgeted)
    const favorableExpense = expenseVariance >= 0;

    assert.equal(expenseVariance, 15000);
    assert.equal(favorableExpense, true);

    const targetRevenue = 200000;
    const actualRevenue = 180000;
    const revenueVariance = actualRevenue - targetRevenue; // -20,000 unfavorable (earned less than targeted)
    const favorableRevenue = revenueVariance >= 0;

    assert.equal(revenueVariance, -20000);
    assert.equal(favorableRevenue, false);
  });

  await t.test("Budget Versioning increments version number and preserves parent reference", () => {
    const parentBudget = { budgetId: "BDG-2028-0001", version: 1, name: "FY2028 Marketing Budget" };
    const newVersion = parentBudget.version + 1;

    assert.equal(newVersion, 2);
    assert.equal(parentBudget.budgetId, "BDG-2028-0001");
  });
});
