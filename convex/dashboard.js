import { internal } from "./_generated/api";
import { query } from "./_generated/server";

// Get User Balances
export const getUserBalances = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    /* 1 to 1 expenses */
    // Only show current users one on one expenses (no groups)
    // Where current user is the payer or owed money
    const expenses = (await ctx.db.query("expenses").collect()).filter(
      (e) =>
        !e.groupId &&
        (e.paidByUserId === user._id ||
          e.splits.some((s) => s.userId === user._id)),
    );

    const balanceByUser = {}; // Detailed breakdown per user // Process each expense to calculate balances

    for (const e of expenses) {
      const isPayer = e.paidByUserId === user._id;
      const mySplit = e.splits.find((s) => s.userId === user._id);

      if (isPayer) {
        for (const s of e.splits) {
          // Skip users's own split or already paid splits
          if (s.userId === user._id || s.paid) continue;

          // Add to amount owed to the user

          if (!balanceByUser[s.userId]) {
            balanceByUser[s.userId] = { owed: 0, owing: 0 };
          }
          balanceByUser[s.userId].owed += s.amount;
        }
      } else if (mySplit && !mySplit.paid) {
        // Someone else paid and user hasn't paid them yet

        // Add to the amount the current user owes to the payer
        if (!balanceByUser[e.paidByUserId]) {
          balanceByUser[e.paidByUserId] = { owed: 0, owing: 0 };
        }
        balanceByUser[e.paidByUserId].owing += mySplit.amount;
      }
    }

    // Get 1-to-1 Settlements (wihtout groupId)
    const settlements = (await ctx.db.query("settlements").collect()).filter(
      (s) =>
        !s.groupId &&
        (s.paidByUserId === user._id || s.receivedByUserId === user._id),
    );

    for (const s of settlements) {
      // Current user paid soemone else => reduce the amount you owe to that user
      if (s.paidByUserId === user._id) {
        if (!balanceByUser[s.receivedByUserId]) {
          balanceByUser[s.receivedByUserId] = { owed: 0, owing: 0 };
        }
        balanceByUser[s.receivedByUserId].owing -= s.amount;
      } else {
        // Another user paid current user => reduce the amount you are owed
        if (!balanceByUser[s.paidByUserId]) {
          balanceByUser[s.paidByUserId] = { owed: 0, owing: 0 };
        }
        balanceByUser[s.paidByUserId].owed -= s.amount;
      }
    }

    /*Build lists for the UI*/
    const youOweList = []; // List of people the user owes money to
    const youAreOwedByList = []; // List of people who ower the user money

    for (const [uid, { owed, owing }] of Object.entries(balanceByUser)) {
      const net = owed - owing; // Calculate net balance
      if (net === 0) continue; // Skip if balanced

      // Get user details
      const counterpart = await ctx.db.get(uid);
      const base = {
        userId: uid,
        name: counterpart?.name ?? "Unknown",
        imageUrl: counterpart?.imageUrl,
        amount: Math.abs(net),
      };

      net > 0 ? youAreOwedByList.push(base) : youOweList.push(base);
    }

    youOweList.sort((a, b) => b.amount - a.amount);
    youAreOwedByList.sort((a, b) => b.amount - a.amount);

    // Get totals from the netted lists so cards and details always match

    const youOwe = youOweList.reduce((sum, u) => sum + u.amount, 0);
    const youAreOwed = youAreOwedByList.reduce((sum, u) => sum + u.amount, 0);

    return {
      youOwe, // Total amount user owes
      youAreOwed, // Total amount owed to user
      totalBalance: youAreOwed - youOwe, // Net Balance
      oweDetails: { youOwe: youOweList, youAreOwedBy: youAreOwedByList }, // Detailed list of users owed/owe
    };
  },
});

export const getTotalSpent = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // create objects that return the current year and start of year
    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1).getTime();

    // query db for all expenses tracked over the course of the year
    const expenses = ctx.db
      .query("expenses")
      .withIndex("by_date", (q) => q.gte("date", startOfYear));

    const allExpenses = await expenses.collect();

    // filter out to find only expenses where user is involved
    const userExpenses = allExpenses.filter(
      (expense) =>
        expense.paidByUserId === user._id ||
        expense.splits.some((split) => split.userId === user._id),
    );

    // initialize totalSpent object as zero
    let totalSpent = 0;

    // loop through each expense to see the users split and add that to the totalSpent object. Finally return totalSpent
    userExpenses.forEach((expense) => {
      const userSplit = expense.splits.find(
        (split) => split.userId === user._id,
      );

      if (userSplit) {
        totalSpent += userSplit.amount;
      }
    });
    return totalSpent;
  },
});

export const getMonthlySpent = query({
  handler: async (ctx) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    const currentYear = new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1).getTime();

    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_date", (q) => q.gte("date", startOfYear))
      .collect();

    const userExpenses = allExpenses.filter(
      (expense) =>
        expense.paidByUserId === user._id ||
        expense.splits.some((split) => split.userId === user._id),
    );

    const monthlyTotals = {};

    for (let i = 0; i < 12; i++) {
      const monthDate = new Date(currentYear, i, 1);
      monthlyTotals[monthDate.getTime()] = 0;
    }

    userExpenses.forEach((expense) => {
      const date = new Date(expense.date);

      const monthStart = new Date(
        date.getFullYear(),
        date.getMonth(),
        1,
      ).getTime();

      const userSplit = expense.splits.find(
        (split) => split.userId === user._id,
      );

      if (userSplit) {
        monthlyTotals[monthStart] =
          (monthlyTotals[monthStart] || 0) + userSplit.amount;
      }
    });

    // Convert monthlyTotals to usable array in order to convert the month string to an int

    const result = Object.entries(monthlyTotals).map(([month, total]) => ({
      month: parseInt(month),
      total,
    }));

    // Sort month in cronological order
    result.sort((a, b) => a.month - b.month);

    return result;
  },
});

export const getUserGroups = query({
  handler: async (ctx) => {
    // Find which user is logged in
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // Get all groups from the database
    const allGroups = await ctx.db.query("groups").collect();

    // Filter to include only group the user is part of
    const groups = allGroups.filter((group) =>
      group.members.some((member) => member.userId === user._id),
    );

    const enhancedGroups = await Promise.all(
      groups.map(async (group) => {
        // get all expenses for this group
        const expenses = await ctx.db
          .query("expenses")
          .withIndex("by_group", (q) => q.eq("groupId", group._id))
          .collect();

        let balance = 0;

        // calculate balance from expenses loop through all expenses
        expenses.forEach((expense) => {
          // if the expense has the same id as user
          if (expense.paidByUserId === user._id) {
            // loop through each of the splits
            expense.splits.forEach((split) => {
              // if the split does not belong to the user and it has
              // not been paid this means others owe the user and add it to
              // the users balance (the amount others owe them)
              if (split.userId !== user._id && !split.paid) {
                balance += split.amount;
              }
            });
          } else {
            // someone else paid and the user might owe them
            const userSplit = expense.splits.find(
              (split) => split.userId === user._id,
            );
            // subtract the amount the user owes in total to people in the group
            // could be multiple people or just one person
            if (userSplit && !userSplit.paid) {
              balance -= userSplit.amount;
            }
          }
        });

        // Apply settlements to adjust the balance
        const settlements = await ctx.db
          .query("settlements")
          .filter((q) =>
            q.and(
              q.eq(q.field("groupId"), group._id),
              q.or(
                q.eq(q.field("paidByUserId"), user._id),
                q.eq(q.field("receivedByUserId"), user._id),
              ),
            ),
          )
          .collect();

        settlements.forEach((settlement) => {
          if (settlement.paidByUserId === user._id) {
            // if the user paid someone in the group their balance goes up -> they owe less now
            balance += settlement.amount;
          } else {
            // Someone paid the user so users balance goes down -> they are owed less now
            balance -= settlement.amount;
          }
        });

        return {
          ...group,
          id: group._id,
          balance,
        };
      }),
    );
    return enhancedGroups;
  },
});
