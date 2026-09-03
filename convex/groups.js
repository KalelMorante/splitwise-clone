import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const getGroupExpenses = query({
  args: { groupId: v.id("groups") },

  handler: async (ctx, { groupId }) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

    const group = await ctx.db.get(groupId);
    if (!group) throw new Error("Group not found");

    if (!group.members.some((m) => m.userId === currentUser._id))
      throw new Error("You are not a member of this group");

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .collect();

    const settlements = await ctx.db
      .query("settlements")
      .filter((q) => q.eq(q.field("groupId"), groupId))
      .collect();

    /* ------ member map ------ */
    const memberDetails = await Promise.all(
      group.members.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return {
          id: u._id,
          name: u.name,
          imageUrl: u.imageUrl,
          role: u.role,
        };
      }),
    );

    const ids = memberDetails.map((m) => m.id);

    // Balance Calculation Setup
    // ----------------------------
    // Initialize totals object to track overall balance for each user
    // Format: {userId1: balance1, userId2: balance2, ... }
    const totals = Object.fromEntries(ids.map((id) => [id, 0]));

    // Create a two-dimensional ledger to track who owes whom
    // ledger[A][B] = how much A owes B
    const ledger = {};

    ids.forEach((a) => {
      ledger[a] = {};
      ids.forEach((b) => {
        if (a != b) ledger[a][b] = 0;
      });
    });

    // Apply Expenses to Balances
    // --------------------------
    // Example:
    // - Expense 1: user1 paid for a meal $60, split equally among all 3 users ($20 each)
    // - After applying this expense:
    //      - totals = { "user1" : +40, "user2" : -20, "user3" : -20}
    //      - ledger = {
    //          "user1" : { "user2" : 0, "user3" : 0}
    //          "user2" : { "user1" : 20, "user3" : 0}
    //          "user3" : { "user1" : 20, "user2" : 0}
    //         }
    //      - This means that user2 owes user1 $20 and user3 owes user1 $20
    for (const exp of expenses) {
      const payer = exp.paidByUserId;

      for (const split of exp.splits) {
        // Skip if this is the payer's own split or if already payed
        if (split.userId === payer || split.paid) continue;

        const debtor = split.userId;
        const amt = split.amount;

        // Update totals: increase payer's balance, decrease debtor's balance
        totals[payer] += amt; // Payer gains credit
        totals[debtor] -= amt; // Debtor goes into debt

        ledger[debtor][payer] += amt;
      }
    }

    // Apply Settlements to Balance
    // ----------------------------
    // Example:
    // - Settlement: user2 paid $10 to user1
    // - After applying settlement:
    //    - totals = { "user1" : +30, "user2" : -10, "user3" : -20 }
    //    - ledger = {
    //        "user1" : { "user2" : 0, "user3" : 0 }
    //        "user2" : { "user1" : 10, "user3" : 0 }
    //        "user3" : { "user1" : 20, "user2" : 0 }
    //        }
    //    - This means that user2 now only owes user1 $10, and user3 still owes user1 $20
    for (const s of settlements) {
      // update totals: increase payers's balance, decrease receiver's balance
      totals[s.paidByUserId] += s.amount;
      totals[s.receivedByUserId] -= s.amount;

      // Update ledger
      ledger[s.paidByUserId][s.receivedByUserId] -= s.amount;
    }

    // Debt simplification - if two people owe each other we want to only take the net sum of the two
    // Example:
    // - Initial Ledger:
    //   - user1 owes user3 $10
    //   - user2 owes user3 $15
    //   - user3 owes user1 $5
    // - After Simplification
    //   - user1 owes user3 $5
    //   - user2 owes user3 $15
    //   - user3 owes user1 $0

    ids.forEach((a) => {
      ids.forEach((b) => {
        if (a > b) return;

        // Calculate the net debt between two users
        const diff = ledger[a][b] - ledger[b][a];

        if (diff > 0) {
          // User A owes User B (net)
          ledger[a][b] = diff;
          ledger[b][a] = 0;
        } else if (diff < 0) {
          // User B owes user A (net)
          ledger[b][a] = -diff;
          ledger[a][b] = 0;
        } else {
          // Theyre even
          ledger[a][b] = ledger[b][a] = 0;
        }
      });
    });

    // Format Response Data
    // --------------------
    // Create a comprehensive balance object for each member
    const balances = memberDetails.map((m) => ({
      ...m,
      totalBalance: totals[m.id],
      owes: Object.entries(ledger[m.id])
        .filter(([, v]) => v > 0)
        .map(([to, amount]) => ({ to, amount })),
      owedBy: ids
        .filter((other) => ledger[other][m.id] > 0)
        .map((other) => ({ from: other, amount: ledger[other][m.id] })),
    }));

    const userLookupMap = {};
    memberDetails.forEach((member) => {
      userLookupMap[member.id] = member;
    });

    return {
      //Group Information
      group: {
        id: group._id,
        name: group.name,
        description: group.description,
      },
      members: memberDetails, // All group members with details
      expenses, // All expenses in this group
      settlements, // All settlements in this group
      balances, // Calculated balance info for each member in the group
      userLookupMap, // Quick lookup for user details
    };
  },
});

export const deleteExpense = mutation({
  args: {
    expenseId: v.id("expenses"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    const expense = await ctx.db.get(args.expenseId);
    if (!expense) {
      throw new Error("Expense not found");
    }

    if (expense.createdBy !== user._id && expense.paidByUserId !== user._id) {
      throw new Error("You don't have permission to delete this expense");
    }

    await ctx.db.delete(args.expenseId);

    return { success: true };
  },
});
