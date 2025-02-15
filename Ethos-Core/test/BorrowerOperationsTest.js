const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol")
const NonPayable = artifacts.require('NonPayable.sol')
const TroveManagerTester = artifacts.require("TroveManagerTester")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester")

const th = testHelpers.TestHelper

const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const ZERO_ADDRESS = th.ZERO_ADDRESS
const assertRevert = th.assertRevert

/* NOTE: Some of the borrowing tests do not test for specific LUSD fee values. They only test that the
 * fees are non-zero when they should occur, and that they decay over time.
 *
 * Specific LUSD fee values will depend on the final fee schedule used, and the final choice for
 *  the parameter MINUTE_DECAY_FACTOR in the TroveManager, which is still TBD based on economic
 * modelling.
 * 
 */

contract('BorrowerOperations', async accounts => {

  const [
    owner, alice, bob, carol, dennis, whale,
    A, B, C, D, E, F, G, H,
    // defaulter_1, defaulter_2,
    frontEnd_1, frontEnd_2, frontEnd_3] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  // const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3]

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let activePool
  let stabilityPool
  let defaultPool
  let borrowerOperations
  let lqtyStaking
  let stakingToken

  let contracts
  let collaterals

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const getTroveEntireColl = async (trove, collAddress) => th.getTroveEntireColl(contracts, trove, collAddress)
  const getTroveEntireDebt = async (trove, collAddress) => th.getTroveEntireDebt(contracts, trove, collAddress)
  const getTroveStake = async (trove, collAddress) => th.getTroveStake(contracts, trove, collAddress)
  const mintCollateralAndApproveBorrowerOps = async (collateral, user, amount) => {
    await collateral.mint(user, amount)
    await collateral.approveInternal(user, borrowerOperations.address, amount)
  }

  let LUSD_GAS_COMPENSATION
  let MIN_NET_DEBT
  let BORROWING_FEE_FLOOR

  before(async () => {

  })

  const testCorpus = ({ withProxy = false }) => {
    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore()
      contracts.borrowerOperations = await BorrowerOperationsTester.new()
      contracts.troveManager = await TroveManagerTester.new()
      contracts = await deploymentHelper.deployLUSDTokenTester(contracts)
      contracts = await deploymentHelper.deployTestCollaterals(contracts)
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(multisig)

      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

      if (withProxy) {
        const users = [alice, bob, carol, dennis, whale, A, B, C, D, E]
        await deploymentHelper.deployProxyScripts(contracts, LQTYContracts, owner, users)
      }

      priceFeed = contracts.priceFeedTestnet
      lusdToken = contracts.lusdToken
      sortedTroves = contracts.sortedTroves
      troveManager = contracts.troveManager
      activePool = contracts.activePool
      stabilityPool = contracts.stabilityPool
      defaultPool = contracts.defaultPool
      borrowerOperations = contracts.borrowerOperations
      hintHelpers = contracts.hintHelpers
      collaterals = contracts.collaterals

      lqtyStaking = LQTYContracts.lqtyStaking
      stakingToken = LQTYContracts.stakingToken
      communityIssuance = LQTYContracts.communityIssuance

      LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
      MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT()
      BORROWING_FEE_FLOOR = await borrowerOperations.BORROWING_FEE_FLOOR()
    })

    it("addColl(): reverts when top-up would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
      assert.isTrue((await troveManager.getCurrentICR(alice, collaterals[0].address, price)).lt(toBN(dec(110, 16))))

      const collTopUp = 1  // 1 wei top up

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp);
      await assertRevert(borrowerOperations.addColl(collaterals[0].address, collTopUp, alice, alice, { from: alice }), 
        "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
      )
    })

    it("addColl(): Increases the activePool collateral balance by correct amount", async () => {
      const { collateral: aliceColl } = await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const activePool_Coll_Before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_Before = await collaterals[0].balanceOf(activePool.address)

      assert.isTrue(activePool_Coll_Before.eq(aliceColl))
      assert.isTrue(activePool_RawColl_Before.eq(aliceColl))

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const collTopUp = dec(1, collDecimals)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp);
      await borrowerOperations.addColl(collaterals[0].address, collTopUp, alice, alice, { from: alice })

      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(aliceColl.add(toBN(dec(1, collDecimals)))))
      assert.isTrue(activePool_RawColl_After.eq(aliceColl.add(toBN(dec(1, collDecimals)))))
    })

    it("addColl(), active Trove: adds the correct collateral amount to the Trove", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const coll_before = alice_Trove_Before[1]
      const status_Before = alice_Trove_Before[3]

      // check status before
      assert.equal(status_Before, 1)

      // Alice adds second collateral
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const collTopUp = dec(1, collDecimals)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp);
      await borrowerOperations.addColl(collaterals[0].address, collTopUp, alice, alice, { from: alice })

      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const coll_After = alice_Trove_After[1]
      const status_After = alice_Trove_After[3]

      // check coll increases by correct amount,and status remains active
      assert.isTrue(coll_After.eq(coll_before.add(toBN(dec(1, collDecimals)))))
      assert.equal(status_After, 1)
    })

    it("addColl(), active Trove: Trove is in sortedList before and after", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check Alice is in list before
      const aliceTroveInList_Before = await sortedTroves.contains(collaterals[0].address, alice)
      const listIsEmpty_Before = await sortedTroves.isEmpty(collaterals[0].address)
      assert.equal(aliceTroveInList_Before, true)
      assert.equal(listIsEmpty_Before, false)

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const collTopUp = dec(1, collDecimals)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp);
      await borrowerOperations.addColl(collaterals[0].address, collTopUp, alice, alice, { from: alice })

      // check Alice is still in list after
      const aliceTroveInList_After = await sortedTroves.contains(collaterals[0].address, alice)
      const listIsEmpty_After = await sortedTroves.isEmpty(collaterals[0].address)
      assert.equal(aliceTroveInList_After, true)
      assert.equal(listIsEmpty_After, false)
    })

    it("addColl(), active Trove: updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 1 ether
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const alice_Stake_Before = alice_Trove_Before[2]
      const totalStakes_Before = (await troveManager.totalStakes(collaterals[0].address))

      assert.isTrue(totalStakes_Before.eq(alice_Stake_Before))

      // Alice tops up Trove collateral with 2 ether
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const collTopUp = dec(2, collDecimals)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp);
      await borrowerOperations.addColl(collaterals[0].address, collTopUp, alice, alice, { from: alice })

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const alice_Stake_After = alice_Trove_After[2]
      const totalStakes_After = (await troveManager.totalStakes(collaterals[0].address))

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.add(toBN(dec(2, collDecimals)))))
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.add(toBN(dec(2, collDecimals)))))
    })

    it("addColl(), active Trove: applies pending rewards and updates user's L_Collateral, L_LUSDDebt snapshots", async () => {
      // --- SETUP ---

      const { collateral: aliceCollBefore, totalDebt: aliceDebtBefore } = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const { collateral: bobCollBefore, totalDebt: bobDebtBefore } = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // --- TEST ---

      // price drops to 1ETH:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(collaterals[0].address, '100000000000000000000');

      // Liquidate Carol's Trove,
      const tx = await troveManager.liquidate(carol, collaterals[0].address,{ from: owner });

      assert.isFalse(await sortedTroves.contains(collaterals[0].address, carol))

      const L_Collateral = await troveManager.L_Collateral(collaterals[0].address)
      const L_LUSDDebt = await troveManager.L_LUSDDebt(collaterals[0].address)

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice, collaterals[0].address)
      const alice_CollateralrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollateralrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollateralrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollateralrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      const alicePendingCollateralReward = await troveManager.getPendingCollateralReward(alice, collaterals[0].address)
      const bobPendingCollateralReward = await troveManager.getPendingCollateralReward(bob, collaterals[0].address)
      const alicePendingLUSDDebtReward = await troveManager.getPendingLUSDDebtReward(alice, collaterals[0].address)
      const bobPendingLUSDDebtReward = await troveManager.getPendingLUSDDebtReward(bob, collaterals[0].address)
      for (reward of [alicePendingCollateralReward, bobPendingCollateralReward, alicePendingLUSDDebtReward, bobPendingLUSDDebtReward]) {
        assert.isTrue(reward.gt(toBN('0')))
      }

      // Alice and Bob top up their Troves
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const aliceTopUp = toBN(dec(5, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, aliceTopUp);
      await borrowerOperations.addColl(collaterals[0].address, aliceTopUp, alice, alice, { from: alice })

      const bobTopUp = toBN(dec(1, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, bobTopUp);
      await borrowerOperations.addColl(collaterals[0].address, bobTopUp, bob, bob, { from: bob })

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups. 
      const aliceNewColl = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceNewDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      const bobNewColl = await getTroveEntireColl(bob, collaterals[0].address)
      const bobNewDebt = await getTroveEntireDebt(bob, collaterals[0].address)

      assert.isTrue(aliceNewColl.eq(aliceCollBefore.add(alicePendingCollateralReward).add(aliceTopUp)))
      assert.isTrue(aliceNewDebt.eq(aliceDebtBefore.add(alicePendingLUSDDebtReward)))
      assert.isTrue(bobNewColl.eq(bobCollBefore.add(bobPendingCollateralReward).add(bobTopUp)))
      assert.isTrue(bobNewDebt.eq(bobDebtBefore.add(bobPendingLUSDDebtReward)))

      /* Check that both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_ETH and L_LUSDDebt */
      const alice_rewardSnapshot_After = await troveManager.rewardSnapshots(alice, collaterals[0].address)
      const alice_CollateralrewardSnapshot_After = alice_rewardSnapshot_After[0]
      const alice_LUSDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1]

      const bob_rewardSnapshot_After = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollateralrewardSnapshot_After = bob_rewardSnapshot_After[0]
      const bob_LUSDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1]

      assert.isAtMost(th.getDifference(alice_CollateralrewardSnapshot_After, L_Collateral), 100)
      assert.isAtMost(th.getDifference(alice_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
      assert.isAtMost(th.getDifference(bob_CollateralrewardSnapshot_After, L_Collateral), 100)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
    })

    // it("addColl(), active Trove: adds the right corrected stake after liquidations have occured", async () => {
    //  // TODO - check stake updates for addColl/withdrawColl/adustTrove ---

    //   // --- SETUP ---
    //   // A,B,C add 15/5/5 ETH, withdraw 100/100/900 LUSD
    //   await borrowerOperations.openTrove(th._100pct, dec(100, 18), alice, alice, { from: alice, value: dec(15, 'ether') })
    //   await borrowerOperations.openTrove(th._100pct, dec(100, 18), bob, bob, { from: bob, value: dec(4, 'ether') })
    //   await borrowerOperations.openTrove(th._100pct, dec(900, 18), carol, carol, { from: carol, value: dec(5, 'ether') })

    //   await borrowerOperations.openTrove(th._100pct, 0, dennis, dennis, { from: dennis, value: dec(1, 'ether') })
    //   // --- TEST ---

    //   // price drops to 1ETH:100LUSD, reducing Carol's ICR below MCR
    //   await priceFeed.setPrice('100000000000000000000');

    //   // close Carol's Trove, liquidating her 5 ether and 900LUSD.
    //   await troveManager.liquidate(carol, { from: owner });

    //   // dennis tops up his trove by 1 ETH
    //   await borrowerOperations.addColl(dennis, dennis, { from: dennis, value: dec(1, 'ether') })

    //   /* Check that Dennis's recorded stake is the right corrected stake, less than his collateral. A corrected 
    //   stake is given by the formula: 

    //   s = totalStakesSnapshot / totalCollateralSnapshot 

    //   where snapshots are the values immediately after the last liquidation.  After Carol's liquidation, 
    //   the ETH from her Trove has now become the totalPendingETHReward. So:

    //   totalStakes = (alice_Stake + bob_Stake + dennis_orig_stake ) = (15 + 4 + 1) =  20 ETH.
    //   totalCollateral = (alice_Collateral + bob_Collateral + dennis_orig_coll + totalPendingETHReward) = (15 + 4 + 1 + 5)  = 25 ETH.

    //   Therefore, as Dennis adds 1 ether collateral, his corrected stake should be:  s = 2 * (20 / 25 ) = 1.6 ETH */
    //   const dennis_Trove = await troveManager.Troves(dennis)

    //   const dennis_Stake = dennis_Trove[2]
    //   console.log(dennis_Stake.toString())

    //   assert.isAtMost(th.getDifference(dennis_Stake), 100)
    // })

    it("addColl(), reverts if trove is non-existent or closed", async () => {
      // A, B open troves
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Carol attempts to add collateral to her non-existent trove
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      try {
        const collTopUp = dec(1, collDecimals)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], carol, collTopUp);
        const txCarol = await borrowerOperations.addColl(collaterals[0].address, collTopUp, carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (error) {
        assert.include(error.message, "revert")
        assert.include(error.message, "Trove does not exist or is closed")
      }

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      // Bob gets liquidated
      await troveManager.liquidate(bob, collaterals[0].address)

      assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

      // Bob attempts to add collateral to his closed trove
      try {
        const collTopUp = dec(1, collDecimals)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, collTopUp);
        const txBob = await borrowerOperations.addColl(collaterals[0].address, collTopUp, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (error) {
        assert.include(error.message, "revert")
        assert.include(error.message, "Trove does not exist or is closed")
      }
    })

    it('addColl(): can add collateral in Recovery Mode', async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, '105000000000000000000')

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const aliceTopUp = toBN(dec(1, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, aliceTopUp);
      await borrowerOperations.addColl(collaterals[0].address, aliceTopUp, alice, alice, { from: alice })

      // Check Alice's collateral
      const aliceCollAfter = (await troveManager.Troves(alice, collaterals[0].address))[1]
      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.add(aliceTopUp)))
    })

    it("addColl(): can add collateral when minting is paused", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)

      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const aliceTopUp = toBN(dec(1, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, aliceTopUp);
      await borrowerOperations.addColl(collaterals[0].address, aliceTopUp, alice, alice, { from: alice })

      // Check Alice's collateral
      const aliceCollAfter = (await troveManager.Troves(alice, collaterals[0].address))[1]
      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.add(aliceTopUp)))
    })

    it("addColl(): allowed even when protocol has been upgraded", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)

      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const aliceTopUp = toBN(dec(1, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, aliceTopUp);
      await borrowerOperations.addColl(collaterals[0].address, aliceTopUp, alice, alice, { from: alice })

      // Check Alice's collateral
      const aliceCollAfter = (await troveManager.Troves(alice, collaterals[0].address))[1]
      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.add(aliceTopUp)))

      // can open trove in new version as well
      await th.openTrove(
        newContracts,
        { collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } }
      );
    })

    // --- withdrawColl() ---

    it("withdrawColl(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
      assert.isTrue((await troveManager.getCurrentICR(alice, collaterals[0].address, price)).lt(toBN(dec(110, 16))))

      const collWithdrawal = 1  // 1 wei withdrawal

     await assertRevert(borrowerOperations.withdrawColl(collaterals[0].address, 1, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    // reverts when calling address does not have active trove  
    it("withdrawColl(): reverts when calling address does not have active trove", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws some coll
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const txBob = await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to withdraw
      try {
        const txCarol = await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): reverts when system is in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Withdrawal possible when recoveryMode == false
      const txAlice = await borrowerOperations.withdrawColl(collaterals[0].address, 1000, alice, alice, { from: alice })
      assert.isTrue(txAlice.receipt.status)

      await priceFeed.setPrice(collaterals[0].address, '105000000000000000000')

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      //Check withdrawal impossible when recoveryMode == true
      try {
        const txBob = await borrowerOperations.withdrawColl(collaterals[0].address, 1000, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      // Bob opens trove with 2nd collateral and withdrawal still possible on that one
      await openTrove({ collateral: collaterals[1], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[1].address))

      // Withdrawal possible when recoveryMode == false
      const txBob = await borrowerOperations.withdrawColl(collaterals[1].address, 1000, bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)
    })

    it("withdrawColl(): reverts when requested collateral withdrawal is > the trove's collateral", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolColl = await getTroveEntireColl(carol, collaterals[0].address)
      const bobColl = await getTroveEntireColl(bob, collaterals[0].address)
      // Carol withdraws exactly all her collateral
      await assertRevert(
        borrowerOperations.withdrawColl(collaterals[0].address, carolColl, carol, carol, { from: carol }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )

      // Bob attempts to withdraw 1 wei more than his collateral
      try {
        const txBob = await borrowerOperations.withdrawColl(collaterals[0].address, bobColl.add(toBN(1)), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): reverts when withdrawal would bring the user's ICR < MCR", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(12, 17)), extraParams: { from: bob } }) // 120% ICR

      // Bob attempts to withdraws 1 wei, Which would leave him with < 110% ICR.

      try {
        const txBob = await borrowerOperations.withdrawColl(collaterals[0].address, 1, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawColl(): reverts if system is in Recovery Mode", async () => {
      // --- SETUP ---

      // A and B open troves at 165% ICR
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: alice } })

      const TCR = (await th.getTCR(contracts, collaterals[0].address)).toString()
      assert.equal(TCR, '1650000000000000000')

      // --- TEST ---

      // price drops to 1ETH:150LUSD, reducing TCR below 165%
      await priceFeed.setPrice(collaterals[0].address, '150000000000000000000');

      //Alice tries to withdraw collateral during Recovery Mode
      try {
        const txData = await borrowerOperations.withdrawColl(collaterals[0].address, '1', alice, alice, { from: alice })
        assert.isFalse(txData.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }
    })

    it("withdrawColl(): doesn’t allow a user to completely withdraw all collateral from their Trove (due to gas compensation)", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceColl = (await troveManager.getEntireDebtAndColl(alice, collaterals[0].address))[1]

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const status_Before = alice_Trove_Before[3]
      assert.equal(status_Before, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))

      // Alice attempts to withdraw all collateral
      await assertRevert(
        borrowerOperations.withdrawColl(collaterals[0].address, aliceColl, alice, alice, { from: alice }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )
    })

    it("withdrawColl(): leaves the Trove active when the user withdraws less than all the collateral", async () => {
      // Open Trove 
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const status_Before = alice_Trove_Before[3]
      assert.equal(status_Before, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))

      // Withdraw some collateral
      await borrowerOperations.withdrawColl(collaterals[0].address, dec(100, 'gwei'), alice, alice, { from: alice })

      // Check Trove is still active
      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const status_After = alice_Trove_After[3]
      assert.equal(status_After, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))
    })

    it("withdrawColl(): reduces the Trove's collateral by the correct amount", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)

      // Alice withdraws 0.1 ether
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const withdrawAmount = toBN(dec(1, collDecimals.sub(toBN(1))))
      await borrowerOperations.withdrawColl(collaterals[0].address, withdrawAmount, alice, alice, { from: alice })

      // Check 1 ether remaining
      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)

      assert.isTrue(aliceCollAfter.eq(aliceCollBefore.sub(withdrawAmount)))
    })

    it("withdrawColl(): reduces ActivePool ETH and raw ether by correct amount", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)

      // check before
      const activePool_Coll_Before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_Before = await collaterals[0].balanceOf(activePool.address)

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      const withdrawAmount = toBN(dec(1, collDecimals.sub(toBN(1))))
      await borrowerOperations.withdrawColl(collaterals[0].address, withdrawAmount, alice, alice, { from: alice })

      // check after
      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(activePool_Coll_Before.sub(withdrawAmount)))
      assert.isTrue(activePool_RawColl_After.eq(activePool_RawColl_Before.sub(withdrawAmount)))
    })

    it("withdrawColl(): updates the stake and updates the total stakes", async () => {
      //  Alice creates initial Trove with 2 ether
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(2, collDecimals)), extraParams: { from: alice } })
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(aliceColl.gt(toBN('0')))

      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const alice_Stake_Before = alice_Trove_Before[2]
      const totalStakes_Before = (await troveManager.totalStakes(collaterals[0].address))

      assert.isTrue(alice_Stake_Before.eq(aliceColl))
      assert.isTrue(totalStakes_Before.eq(aliceColl))

      // Alice withdraws 1 ether
      await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), alice, alice, { from: alice })

      // Check stake and total stakes get updated
      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const alice_Stake_After = alice_Trove_After[2]
      const totalStakes_After = (await troveManager.totalStakes(collaterals[0].address))

      assert.isTrue(alice_Stake_After.eq(alice_Stake_Before.sub(toBN(dec(1, collDecimals)))))
      assert.isTrue(totalStakes_After.eq(totalStakes_Before.sub(toBN(dec(1, collDecimals)))))
    })

    it("withdrawColl(): sends the correct amount of collateral to the user", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(2, collDecimals)), extraParams: { from: alice } })

      const alice_collBalance_Before = await collaterals[0].balanceOf(alice)
      await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), alice, alice, { from: alice, gasPrice: 0 })

      const alice_collBalance_After = await collaterals[0].balanceOf(alice)
      const balanceDiff = alice_collBalance_After.sub(alice_collBalance_Before)

      assert.isTrue(balanceDiff.eq(toBN(dec(1, collDecimals))))
    })

    it("withdrawColl(): applies pending rewards and updates user's L_Collateral, L_LUSDDebt snapshots", async () => {
      // --- SETUP ---
      // Alice adds 15 ether, Bob adds 5 ether, Carol adds 1 ether
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], value: toBN(dec(15, collDecimals)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], value: toBN(dec(5, collDecimals)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], value: toBN(dec(1, collDecimals)), extraParams: { from: carol } })

      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const bobCollBefore = await getTroveEntireColl(bob, collaterals[0].address)
      const bobDebtBefore = await getTroveEntireDebt(bob, collaterals[0].address)

      // --- TEST ---

      // price drops to 1ETH:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(collaterals[0].address, '100000000000000000000');

      // close Carol's Trove, liquidating her 1 ether and 180LUSD.
      await troveManager.liquidate(carol, collaterals[0].address, { from: owner });

      const L_Collateral = await troveManager.L_Collateral(collaterals[0].address)
      const L_LUSDDebt = await troveManager.L_LUSDDebt(collaterals[0].address)

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice, collaterals[0].address)
      const alice_CollrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      // Check A and B have pending rewards
      const pendingCollReward_A = await troveManager.getPendingCollateralReward(alice, collaterals[0].address)
      const pendingDebtReward_A = await troveManager.getPendingLUSDDebtReward(alice, collaterals[0].address)
      const pendingCollReward_B = await troveManager.getPendingCollateralReward(bob, collaterals[0].address)
      const pendingDebtReward_B = await troveManager.getPendingLUSDDebtReward(bob, collaterals[0].address)
      for (reward of [pendingCollReward_A, pendingDebtReward_A, pendingCollReward_B, pendingDebtReward_B]) {
        assert.isTrue(reward.gt(toBN('0')))
      }

      // Alice and Bob withdraw from their Troves
      const aliceCollWithdrawal = toBN(dec(5, collDecimals))
      const bobCollWithdrawal = toBN(dec(1, collDecimals))

      await borrowerOperations.withdrawColl(collaterals[0].address, aliceCollWithdrawal, alice, alice, { from: alice })
      await borrowerOperations.withdrawColl(collaterals[0].address, bobCollWithdrawal, bob, bob, { from: bob })

      // Check that both alice and Bob have had pending rewards applied in addition to their top-ups. 
      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceDebtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const bobCollAfter = await getTroveEntireColl(bob, collaterals[0].address)
      const bobDebtAfter = await getTroveEntireDebt(bob, collaterals[0].address)

      // Check rewards have been applied to troves
      th.assertIsApproximatelyEqual(aliceCollAfter, aliceCollBefore.add(pendingCollReward_A).sub(aliceCollWithdrawal), 10000)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(pendingDebtReward_A), 10000)
      th.assertIsApproximatelyEqual(bobCollAfter, bobCollBefore.add(pendingCollReward_B).sub(bobCollWithdrawal), 10000)
      th.assertIsApproximatelyEqual(bobDebtAfter, bobDebtBefore.add(pendingDebtReward_B), 10000)

      /* After top up, both Alice and Bob's snapshots of the rewards-per-unit-staked metrics should be updated
       to the latest values of L_ETH and L_LUSDDebt */
      const alice_rewardSnapshot_After = await troveManager.rewardSnapshots(alice, collaterals[0].address)
      const alice_CollrewardSnapshot_After = alice_rewardSnapshot_After[0]
      const alice_LUSDDebtRewardSnapshot_After = alice_rewardSnapshot_After[1]

      const bob_rewardSnapshot_After = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollrewardSnapshot_After = bob_rewardSnapshot_After[0]
      const bob_LUSDDebtRewardSnapshot_After = bob_rewardSnapshot_After[1]

      assert.isAtMost(th.getDifference(alice_CollrewardSnapshot_After, L_Collateral), 100)
      assert.isAtMost(th.getDifference(alice_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
      assert.isAtMost(th.getDifference(bob_CollrewardSnapshot_After, L_Collateral), 100)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot_After, L_LUSDDebt), 100)
    })

    it("withdrawColl(): can withdraw collateral when minting is paused", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(2, collDecimals)), extraParams: { from: alice } })

      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);

      const alice_collBalance_Before = await collaterals[0].balanceOf(alice)
      await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), alice, alice, { from: alice, gasPrice: 0 })

      const alice_collBalance_After = await collaterals[0].balanceOf(alice)
      const balanceDiff = alice_collBalance_After.sub(alice_collBalance_Before)

      assert.isTrue(balanceDiff.eq(toBN(dec(1, collDecimals))))
    })

    it("withdrawColl(): allowed even when protocol has been upgraded", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(2, collDecimals)), extraParams: { from: alice } })
      const alice_collBalance_Before = await collaterals[0].balanceOf(alice)

      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      await borrowerOperations.withdrawColl(collaterals[0].address, dec(1, collDecimals), alice, alice, { from: alice, gasPrice: 0 })

      const alice_collBalance_After = await collaterals[0].balanceOf(alice)
      const balanceDiff = alice_collBalance_After.sub(alice_collBalance_Before)

      assert.isTrue(balanceDiff.eq(toBN(dec(1, collDecimals))))

      // can open trove in new version as well
      await th.openTrove(
        newContracts,
        { collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } }
      );
    })

    // --- withdrawLUSD() ---

    it("withdrawLUSD(): reverts when withdrawal would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
      assert.isTrue((await troveManager.getCurrentICR(alice, collaterals[0].address, price)).lt(toBN(dec(120, 16))))

      const LUSDwithdrawal = 1  // withdraw 1 wei LUSD

     await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, LUSDwithdrawal, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("withdrawLUSD(): decays a non-zero base rate", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const A_LUSDBal = await lusdToken.balanceOf(A)

      // Artificially set base rate to 5%
      await troveManager.setBaseRate(dec(5, 16))

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), A, A, { from: D })

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), A, A, { from: E })

      const baseRate_3 = await troveManager.baseRate()
      assert.isTrue(baseRate_3.lt(baseRate_2))
    })

    it("withdrawLUSD(): reverts if max fee > 100%", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, dec(2, 18), dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, '1000000000000000001', dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("withdrawLUSD(): reverts if max fee < 0.5% in Normal mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, 0, dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, 1, dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, '4999999999999999', dec(1, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("withdrawLUSD(): reverts if fee exceeds max fee percentage", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(70, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(80, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(180, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const totalSupply = await lusdToken.totalSupply()

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      let baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // 100%: 1e18,  10%: 1e17,  1%: 1e16,  0.1%: 1e15
      // 5%: 5e16
      // 0.5%: 5e15
      // actual: 0.5%, 5e15


      // LUSDFee:                  15000000558793542
      // absolute _fee:            15000000558793542
      // actual feePercentage:      5000000186264514
      // user's _maxFeePercentage: 49999999999999999

      const lessThan5pct = '49999999999999999'
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, lessThan5pct, dec(3, 18), A, A, { from: A }), "Fee exceeded provided maximum")

      baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 1%
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, dec(1, 16), dec(1, 18), A, A, { from: B }), "Fee exceeded provided maximum")

      baseRate = await troveManager.baseRate()  // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 3.754%
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, dec(3754, 13), dec(1, 18), A, A, { from: C }), "Fee exceeded provided maximum")

      baseRate = await troveManager.baseRate()  // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))
      // Attempt with maxFee 0.5%%
      await assertRevert(borrowerOperations.withdrawLUSD(collaterals[0].address, dec(5, 15), dec(1, 18), A, A, { from: D }), "Fee exceeded provided maximum")
    })

    it("withdrawLUSD(): succeeds when fee is less than max fee percentage", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(60, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(70, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(80, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(180, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const totalSupply = await lusdToken.totalSupply()

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      let baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.isTrue(baseRate.eq(toBN(dec(5, 16))))

      // Attempt with maxFee > 5%
      const moreThan5pct = '50000000000000001'
      const tx1 = await borrowerOperations.withdrawLUSD(collaterals[0].address, moreThan5pct, dec(1, 18), A, A, { from: A })
      assert.isTrue(tx1.receipt.status)

      baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee = 5%
      const tx2 = await borrowerOperations.withdrawLUSD(collaterals[0].address, dec(5, 16), dec(1, 18), A, A, { from: B })
      assert.isTrue(tx2.receipt.status)

      baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee 10%
      const tx3 = await borrowerOperations.withdrawLUSD(collaterals[0].address, dec(1, 17), dec(1, 18), A, A, { from: C })
      assert.isTrue(tx3.receipt.status)

      baseRate = await troveManager.baseRate() // expect 5% base rate
      assert.equal(baseRate, dec(5, 16))

      // Attempt with maxFee 37.659%
      const tx4 = await borrowerOperations.withdrawLUSD(collaterals[1].address, dec(37659, 13), dec(1, 18), A, A, { from: D })
      assert.isTrue(tx4.receipt.status)

      // Attempt with maxFee 100%
      const tx5 = await borrowerOperations.withdrawLUSD(collaterals[1].address, dec(1, 18), dec(1, 18), A, A, { from: E })
      assert.isTrue(tx5.receipt.status)
    })

    it("withdrawLUSD(): doesn't change base rate if it is already zero", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(37, 18), A, A, { from: D })

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(12, 18), A, A, { from: E })

      const baseRate_3 = await troveManager.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("withdrawLUSD(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime()

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider)

      // Borrower C triggers a fee
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), C, C, { from: C })

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60))

      // Borrower C triggers a fee
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), C, C, { from: C })

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })


    it("withdrawLUSD(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider)

      // Borrower C triggers a fee, before decay interval has passed
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), C, C, { from: C })

      // 30 seconds pass
      th.fastForwardTime(30, web3.currentProvider)

      // Borrower C triggers another fee
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), C, C, { from: C })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("withdrawLUSD(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(37, 18), C, C, { from: D })

      // Check LQTY LUSD balance after has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("withdrawLUSD(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
        const D_debtBefore = await getTroveEntireDebt(D, collaterals[1].address)

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16))
        await troveManager.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        // D withdraws LUSD
        const withdrawal_D = toBN(dec(15, 18))
        const withdrawalTx = await borrowerOperations.withdrawLUSD(collaterals[1].address, th._100pct, toBN(dec(15, 18)), D, D, { from: D })

        const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(withdrawalTx))
        assert.isTrue(emittedFee.gt(toBN('0')))

        const newDebt = (await troveManager.Troves(D, collaterals[1].address))[0]

        // Check debt on Trove struct equals initial debt + withdrawal + emitted fee
        th.assertIsApproximatelyEqual(newDebt, D_debtBefore.add(withdrawal_D).add(emittedFee), 10000)
      })
    }

    it("withdrawLUSD(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, toBN(dec(37, 18)), D, D, { from: D })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("withdrawLUSD(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D withdraws LUSD
      const D_LUSDRequest = toBN(dec(37, 18))
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, D_LUSDRequest, D, D, { from: D })

      // Check LQTY staking LUSD balance has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance now equals their initial balance plus request LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(D_LUSDRequest)))
    })

    it("withdrawLUSD(): Borrowing at zero base rate changes LUSD fees-per-unit-staked", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // A artificially receives LQTY, then stakes it
      await stakingToken.mint(A, dec(100, 18))
      await stakingToken.approve(lqtyStaking.address, dec(100, 18), { from: A })
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check LQTY LUSD balance before == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      // D withdraws LUSD
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(37, 18), D, D, { from: D })

      // Check LQTY LUSD balance after > 0
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt('0'))
    })

    it("withdrawLUSD(): Borrowing at zero base rate sends debt request to user", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D withdraws LUSD
      const D_LUSDRequest = toBN(dec(37, 18))
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(37, 18), D, D, { from: D })

      // Check D's LUSD balance now equals their requested LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)

      // Check D's trove debt == D's LUSD balance + liquidation reserve
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(D_LUSDRequest)))
    })

    it("withdrawLUSD(): reverts when calling address does not have active trove", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws LUSD
      const txBob = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to withdraw LUSD
      try {
        const txCarol = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(100, 18), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      // Alice tries to withdraw against different collaterals
      try {
        const txAlice = await borrowerOperations.withdrawLUSD(collaterals[1].address, th._100pct, dec(100, 18), alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when requested withdrawal amount is zero LUSD", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Bob successfully withdraws 1e-18 LUSD
      const txBob = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, 1, bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Alice attempts to withdraw 0 LUSD
      try {
        const txAlice = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, 0, alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when system is in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[1], ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
      await openTrove({ collateral: collaterals[1], ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[1].address))

      // Withdrawal possible when recoveryMode == false
      const txAlice = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10, 18), alice, alice, { from: alice })
      assert.isTrue(txAlice.receipt.status)
      const txDennis = await borrowerOperations.withdrawLUSD(collaterals[1].address, th._100pct, dec(10, 18), dennis, dennis, { from: dennis })
      assert.isTrue(txDennis.receipt.status)

      await priceFeed.setPrice(collaterals[0].address, '50000000000000000000')

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[1].address))

      //Check LUSD withdrawal impossible when recoveryMode == true
      try {
        const txBob = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, 1, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      const txCarol = await borrowerOperations.withdrawLUSD(collaterals[1].address, th._100pct, dec(10, 18), carol, carol, { from: carol })
      assert.isTrue(txCarol.receipt.status)
    })

    it("withdrawLUSD(): reverts when withdrawal would bring the trove's ICR < MCR", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(12, 17)), extraParams: { from: bob } })

      // Bob tries to withdraw LUSD that would bring his ICR < MCR
      try {
        const txBob = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, 1, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts when a withdrawal would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      // Alice and Bob creates troves with 165% ICR.  System TCR = 165%.
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: bob } })

      var TCR = (await th.getTCR(contracts, collaterals[0].address)).toString()
      assert.equal(TCR, '1650000000000000000')

      // Bob attempts to withdraw 1 LUSD.
      // System TCR would be: ((3+3) * 100 ) / (200+201) = 600/401 = 149.62%, i.e. below CCR of 150%.
      try {
        const txBob = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(1, 18), bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("withdrawLUSD(): reverts if system is in Recovery Mode", async () => {
      // --- SETUP ---
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: bob } })

      // --- TEST ---

      // price drops to 1ETH:150LUSD, reducing TCR below 165%
      await priceFeed.setPrice(collaterals[0].address, '150000000000000000000');
      assert.isTrue((await th.getTCR(contracts, collaterals[0].address)).lt(toBN(dec(165, 16))))

      try {
        const txData = await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, '200', alice, alice, { from: alice })
        assert.isFalse(txData.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }
    })

    it("withdrawLUSD(): increases the Trove's LUSD debt by the correct amount", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check before
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN(0)))

      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, await getNetBorrowingAmount(100), alice, alice, { from: alice })

      // check after
      const aliceDebtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.add(toBN(100)))
    })

    it("withdrawLUSD(): increases LUSD debt in ActivePool by correct amount", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } })

      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN(0)))

      // check before
      const activePool_LUSD_Before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSD_Before.eq(aliceDebtBefore))

      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, await getNetBorrowingAmount(dec(1000, 18)), alice, alice, { from: alice })

      // check after
      const activePool_LUSD_After = await activePool.getLUSDDebt(collaterals[0].address)
      th.assertIsApproximatelyEqual(activePool_LUSD_After, activePool_LUSD_Before.add(toBN(dec(1000, 18))))
    })

    it("withdrawLUSD(): increases user LUSDToken balance by correct amount", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } })

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10000, 18), alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.add(toBN(dec(10000, 18)))))
    })

    it("withdrawLUSD(): reverts when minting is paused", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } })

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);
      await assertRevert(
        borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10000, 18), alice, alice, { from: alice }),
        "LUSDToken: Minting is currently paused"
      );

      // unpause minting
      await contracts.governance.execute(lusdToken.address, 0, th.getTransactionData('unpauseMinting()', []), 0, 100_000);
      await borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10000, 18), alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.add(toBN(dec(10000, 18)))))
    })

    it("withdrawLUSD(): disallowed once protocol has been upgraded", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } })

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      await assertRevert(
        borrowerOperations.withdrawLUSD(collaterals[0].address, th._100pct, dec(10000, 18), alice, alice, { from: alice }),
        "LUSDToken: Caller is not BorrowerOperations"
      );

      // can open trove and withdraw more LUSD in new version though
      await th.openTrove(
        newContracts,
        { collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraParams: { from: alice } }
      )

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.gt(alice_LUSDTokenBalance_Before.add(toBN(dec(89, 18)))));
      assert.isTrue(alice_LUSDTokenBalance_After.lt(alice_LUSDTokenBalance_Before.add(toBN(dec(90, 18)))));
    })

    // --- repayLUSD() ---
    it("repayLUSD(): reverts when repayment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
      assert.isTrue((await troveManager.getCurrentICR(alice, collaterals[0].address, price)).lt(toBN(dec(120, 16))))

      const LUSDRepayment = 1  // 1 wei repayment

     await assertRevert(borrowerOperations.repayLUSD(collaterals[0].address, LUSDRepayment, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("repayLUSD(): Succeeds when it would leave trove with net debt >= minimum net debt", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      // Make the LUSD request 2 wei above min net debt to correct for floor division, and make net debt = min net debt + 1 wei
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(100, 30))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, 30), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN('2'))), A, A, { from: A })

      const repayTxA = await borrowerOperations.repayLUSD(collaterals[0].address, 1, A, A, { from: A })
      assert.isTrue(repayTxA.receipt.status)

      await mintCollateralAndApproveBorrowerOps(collaterals[0], B, dec(100, 30))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, 30), th._100pct, dec(20, 25), B, B, { from: B })

      const repayTxB = await borrowerOperations.repayLUSD(collaterals[0].address, dec(19, 25), B, B, { from: B })
      assert.isTrue(repayTxB.receipt.status)
    })

    it("repayLUSD(): reverts when it would leave trove with net debt < minimum net debt", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      // Make the LUSD request 2 wei above min net debt to correct for floor division, and make net debt = min net debt + 1 wei
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(100, 30))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, 30), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN('2'))), A, A, { from: A })

      const repayTxAPromise = borrowerOperations.repayLUSD(collaterals[0].address, 2, A, A, { from: A })
      await assertRevert(repayTxAPromise, "BorrowerOps: Trove's net debt must be greater than minimum")
    })

    it("adjustTrove(): Reverts if repaid amount is greater than current debt", async () => {
      const { totalDebt } = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
      const repayAmount = totalDebt.sub(LUSD_GAS_COMPENSATION).add(toBN(1))
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: repayAmount, ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

      await lusdToken.transfer(alice, repayAmount, { from: bob })

      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, 0, th._100pct, 0, repayAmount, false, alice, alice, { from: alice }),
                         "SafeMath: subtraction overflow")
    })

    it("repayLUSD(): reverts when calling address does not have active trove", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      // Bob successfully repays some LUSD
      const txBob = await borrowerOperations.repayLUSD(collaterals[0].address, dec(10, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Carol with no active trove attempts to repayLUSD
      try {
        const txCarol = await borrowerOperations.repayLUSD(collaterals[0].address, dec(10, 18), carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("repayLUSD(): reverts when attempted repayment is > the debt of the trove", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)

      // Bob successfully repays some LUSD
      const txBob = await borrowerOperations.repayLUSD(collaterals[0].address, dec(10, 18), bob, bob, { from: bob })
      assert.isTrue(txBob.receipt.status)

      // Alice attempts to repay more than her debt
      try {
        const txAlice = await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebt.add(toBN(dec(1, 18))), alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    //repayLUSD: reduces LUSD debt in Trove
    it("repayLUSD(): reduces the Trove's LUSD debt by the correct amount", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      const aliceDebtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtAfter.gt(toBN('0')))

      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10)))  // check 9/10 debt remaining
    })

    it("repayLUSD(): decreases LUSD debt in ActivePool by correct amount", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // Check before
      const activePool_LUSD_Before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSD_Before.gt(toBN('0')))

      await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const activePool_LUSD_After = await activePool.getLUSDDebt(collaterals[0].address)
      th.assertIsApproximatelyEqual(activePool_LUSD_After, activePool_LUSD_Before.sub(aliceDebtBefore.div(toBN(10))))
    })

    it("repayLUSD(): decreases user LUSDToken balance by correct amount", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDTokenBalance_After, alice_LUSDTokenBalance_Before.sub(aliceDebtBefore.div(toBN(10))))
    })

    it('repayLUSD(): can repay debt in Recovery Mode', async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, '105000000000000000000')

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const tx = await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      // Check Alice's debt: 110 (initial) - 50 (repaid)
      const aliceDebtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      th.assertIsApproximatelyEqual(aliceDebtAfter, aliceDebtBefore.mul(toBN(9)).div(toBN(10)))
    })

    it("repayLUSD(): Reverts if borrower has insufficient LUSD balance to cover his debt repayment", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      const bobBalBefore = await lusdToken.balanceOf(B)
      assert.isTrue(bobBalBefore.gt(toBN('0')))

      // Bob transfers all but 5 of his LUSD to Carol
      await lusdToken.transfer(C, bobBalBefore.sub((toBN(dec(5, 18)))), { from: B })

      //Confirm B's LUSD balance has decreased to 5 LUSD
      const bobBalAfter = await lusdToken.balanceOf(B)

      assert.isTrue(bobBalAfter.eq(toBN(dec(5, 18))))
      
      // Bob tries to repay 6 LUSD
      const repayLUSDPromise_B = borrowerOperations.repayLUSD(collaterals[1].address, toBN(dec(6, 18)), B, B, { from: B })

      await assertRevert(repayLUSDPromise_B, "Caller doesnt have enough LUSD to make repayment")
    })

    it("repayLUSD(): can repay debt when minting is paused", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);
      await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDTokenBalance_After, alice_LUSDTokenBalance_Before.sub(aliceDebtBefore.div(toBN(10))))
    })

    it("repayLUSD(): allowed even when protocol has been upgraded", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))

      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      await borrowerOperations.repayLUSD(collaterals[0].address, aliceDebtBefore.div(toBN(10)), alice, alice, { from: alice })  // Repays 1/10 her debt

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDTokenBalance_After, alice_LUSDTokenBalance_Before.sub(aliceDebtBefore.div(toBN(10))))

      // can open trove in new version as well
      await th.openTrove(
        newContracts,
        { collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } }
      );
    })

    // --- adjustTrove() ---

    it("adjustTrove(): reverts when adjustment would leave trove with ICR < MCR", async () => {
      // alice creates a Trove and adds first collateral
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
      assert.isTrue((await troveManager.getCurrentICR(alice, collaterals[0].address, price)).lt(toBN(dec(120, 16))))

      const LUSDRepayment = 1  // 1 wei repayment
      const collTopUp = 1

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collTopUp)
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, collTopUp, 0, LUSDRepayment, false, alice, alice, { from: alice }), 
      "BorrowerOps: An operation that would result in ICR < MCR is not permitted")
    })

    it("adjustTrove(): reverts if max fee < 0.5% in Normal mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })

      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(300, 16))
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, 0, dec(2, 16), 0, dec(1, 18), true, A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, 1, dec(2, 16), 0, dec(1, 18), true, A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, '4999999999999999', dec(2, 16), 0, dec(1, 18), true, A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("adjustTrove(): allows max fee < 0.5% in Recovery mode", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })

      await priceFeed.setPrice(collaterals[0].address, dec(120, 18))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(300, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, 0, dec(300, collDecimals), 0, dec(1, 9), true, A, A, { from: A })
      await priceFeed.setPrice(collaterals[0].address, dec(1, 18))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(30000, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, 1, dec(30000, collDecimals), 0, dec(1, 9), true, A, A, { from: A })
      await priceFeed.setPrice(collaterals[0].address, dec(1, 16))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(3000000, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, '4999999999999999', dec(3000000, collDecimals), 0, dec(1, 9), true, A, A, { from: A })
    })

    it("adjustTrove(): decays a non-zero base rate", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await borrowerOperations.adjustTrove(collaterals[1].address, th._100pct, 0, 0, dec(15, 18), true, D, D, { from: D })

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E adjusts trove
      await borrowerOperations.adjustTrove(collaterals[1].address, th._100pct, 0, 0, dec(37, 15), true, E, E, { from: D })

      const baseRate_3 = await troveManager.baseRate()
      assert.isTrue(baseRate_3.lt(baseRate_2))
    })

    it("adjustTrove(): doesn't decay a non-zero base rate when user issues 0 debt", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // D opens trove 
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove with 0 debt
      await mintCollateralAndApproveBorrowerOps(collaterals[1], D, dec(1, 'ether'))
      await borrowerOperations.adjustTrove(collaterals[1].address, th._100pct, dec(1, 'ether'), 0, 0, false, D, D, { from: D })

      // Check baseRate has not decreased 
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.eq(baseRate_1))
    })

    it("adjustTrove(): doesn't change base rate if it is already zero", async () => {
      await openTrove({ collateral: collaterals[0],  extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })
      await openTrove({ collateral: collaterals[0],  extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(37, 18), true, D, D, { from: D })

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E adjusts trove
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(37, 15), true, E, E, { from: D })

      const baseRate_3 = await troveManager.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("adjustTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime()

      // 10 seconds pass
      th.fastForwardTime(10, web3.currentProvider)

      // Borrower C triggers a fee
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, C, C, { from: C })

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 60 seconds passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(60))

      // Borrower C triggers a fee
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, C, C, { from: C })

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })

    it("adjustTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // Borrower C triggers a fee, before decay interval of 1 minute has passed
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, C, C, { from: C })

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider)

      // Borrower C triggers another fee
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, C, C, { from: C })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("adjustTrove(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY LUSD balance after has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("adjustTrove(): borrowing at non-zero base records the (drawn debt + fee) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
        const D_debtBefore = await getTroveEntireDebt(D, collaterals[0].address)

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16))
        await troveManager.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        const withdrawal_D = toBN(dec(37, 18))

        // D withdraws LUSD
        const adjustmentTx = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, withdrawal_D, true, D, D, { from: D })

        const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(adjustmentTx))
        assert.isTrue(emittedFee.gt(toBN('0')))

        const D_newDebt = (await troveManager.Troves(D, collaterals[0].address))[0]
    
        // Check debt on Trove struct equals initila debt plus drawn debt plus emitted fee
        assert.isTrue(D_newDebt.eq(D_debtBefore.add(withdrawal_D).add(emittedFee)))
      })
    }

    it("adjustTrove(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(37, 18), true, D, D, { from: D })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("adjustTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const D_LUSDBalanceBefore = await lusdToken.balanceOf(D)

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D adjusts trove
      const LUSDRequest_D = toBN(dec(40, 18))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, LUSDRequest_D, true, D, D, { from: D })

      // Check LQTY staking LUSD balance has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance has increased by their requested LUSD
      const D_LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(D_LUSDBalanceAfter.eq(D_LUSDBalanceBefore.add(LUSDRequest_D)))
    })

    it("adjustTrove(): Borrowing at zero base rate changes LUSD balance of LQTY staking contract", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(50, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check staking LUSD balance before > 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_Before.gt(toBN('0')))

      // D adjusts trove
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(37, 18), true, D, D, { from: D })

      // Check staking LUSD balance after > staking balance before
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    it("adjustTrove(): Borrowing at zero base rate changes LQTY staking contract LUSD fees-per-unit-staked", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // A artificially receives LQTY, then stakes it
      await stakingToken.mint(A, dec(100, 18))
      await stakingToken.approve(lqtyStaking.address, dec(100, 18), { from: A })
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // Check staking LUSD balance before == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_Before.eq(toBN('0')))

      // D adjusts trove
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(37, 18), true, D, D, { from: D })

      // Check staking LUSD balance increases
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("adjustTrove(): Borrowing at zero base rate sends total requested LUSD to the user", async () => {
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await openTrove({ collateral: collaterals[0], value: toBN(dec(100, collDecimals)), extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const D_LUSDBalBefore = await lusdToken.balanceOf(D)
      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      const DUSDBalanceBefore = await lusdToken.balanceOf(D)

      // D adjusts trove
      const LUSDRequest_D = toBN(dec(40, 18))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, LUSDRequest_D, true, D, D, { from: D })

      // Check D's LUSD balance increased by their requested LUSD
      const LUSDBalanceAfter = await lusdToken.balanceOf(D)
      assert.isTrue(LUSDBalanceAfter.eq(D_LUSDBalBefore.add(LUSDRequest_D)))
    })

    it("adjustTrove(): reverts when calling address has no active trove", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Alice coll and debt increase(+1 ETH, +50LUSD)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(50, 18), true, alice, alice, { from: alice })

      try {
        await mintCollateralAndApproveBorrowerOps(collaterals[0], carol, dec(1, collDecimals))
        const txCarol = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(50, 18), true, carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): reverts in Recovery Mode when the adjustment would reduce the TCR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      const txAlice = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(50, 18), true, alice, alice, { from: alice })
      assert.isTrue(txAlice.receipt.status)

      await priceFeed.setPrice(collaterals[0].address, dec(120, 18)) // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      try { // collateral withdrawal should also fail
        const txAlice = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(1, collDecimals), 0, false, alice, alice, { from: alice })
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      try { // debt increase should fail
        const txBob = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(50, 18), true, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      try { // debt increase that's also a collateral increase should also fail, if ICR will be worse off
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, dec(1, collDecimals))
        const txBob = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(111, 18), true, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): collateral withdrawal reverts in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(120, 18)) // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Alice attempts an adjustment that repays half her debt BUT withdraws 1 wei collateral, and fails
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 1, dec(5000, 18), false, alice, alice, { from: alice }),
        "BorrowerOps: Collateral withdrawal not permitted Recovery Mode")
    })

    it("adjustTrove(): debt increase that would leave ICR < 150% reverts in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await contracts.collateralConfig.getCollateralCCR(collaterals[0].address)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(120, 18)) // trigger drop in ETH price
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const ICR_A = await troveManager.getCurrentICR(alice, collaterals[0].address, price)

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      const debtIncrease = toBN(dec(50, 18))
      const collIncrease = toBN(dec(1, collDecimals))

      // Check the new ICR would be an improvement, but less than the CCR (165%)
      const newICR = await troveManager.computeICR(aliceColl.add(collIncrease), aliceDebt.add(debtIncrease), price, collDecimals)

      assert.isTrue(newICR.gt(ICR_A) && newICR.lt(CCR))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collIncrease)
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, collIncrease, 0, debtIncrease, true, alice, alice, { from: alice }),
        "BorrowerOps: Operation must leave trove with ICR >= CCR")
    })

    it("adjustTrove(): debt increase that would reduce the ICR reverts in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await contracts.collateralConfig.getCollateralCCR(collaterals[0].address)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(115, 18)) // trigger drop in ETH price
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      //--- Alice with ICR > 165% tries to reduce her ICR ---

      const ICR_A = await troveManager.getCurrentICR(alice, collaterals[0].address, price)

      // Check Alice's initial ICR is above 165%
      assert.isTrue(ICR_A.gt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceDebtIncrease = toBN(dec(150, 18))
      const aliceCollIncrease = toBN(dec(1, collDecimals))

      const newICR_A = await troveManager.computeICR(aliceColl.add(aliceCollIncrease), aliceDebt.add(aliceDebtIncrease), price, collDecimals)

      // Check Alice's new ICR would reduce but still be greater than 165%
      assert.isTrue(newICR_A.lt(ICR_A) && newICR_A.gt(CCR))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, aliceCollIncrease)
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, aliceCollIncrease, 0, aliceDebtIncrease, true, alice, alice, { from: alice }),
        "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode")

      //--- Bob with ICR < 150% tries to reduce his ICR ---

      const ICR_B = await troveManager.getCurrentICR(bob, collaterals[0].address, price)

      // Check Bob's initial ICR is below 165%
      assert.isTrue(ICR_B.lt(CCR))

      const bobDebt = await getTroveEntireDebt(bob, collaterals[0].address)
      const bobColl = await getTroveEntireColl(bob, collaterals[0].address)
      const bobDebtIncrease = toBN(dec(450, 18))
      const bobCollIncrease = toBN(dec(1, collDecimals))

      const newICR_B = await troveManager.computeICR(bobColl.add(bobCollIncrease), bobDebt.add(bobDebtIncrease), price, collDecimals)

      // Check Bob's new ICR would reduce 
      assert.isTrue(newICR_B.lt(ICR_B))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, bobCollIncrease)
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, bobCollIncrease, 0, bobDebtIncrease, true, bob, bob, { from: bob }),
        " BorrowerOps: Operation must leave trove with ICR >= CCR")
    })

    it("adjustTrove(): A trove with ICR < CCR in Recovery Mode can adjust their trove to ICR > CCR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await contracts.collateralConfig.getCollateralCCR(collaterals[0].address)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(100, 18)) // trigger drop in ETH price
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const ICR_A = await troveManager.getCurrentICR(alice, collaterals[0].address, price)
      // Check initial ICR is below 165%
      assert.isTrue(ICR_A.lt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      const debtIncrease = toBN(dec(5000, 18))
      const collIncrease = toBN(dec(163, collDecimals))

      const newICR = await troveManager.computeICR(aliceColl.add(collIncrease), aliceDebt.add(debtIncrease), price, collDecimals)

      // Check new ICR would be > 165%
      assert.isTrue(newICR.gt(CCR))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collIncrease)
      const tx = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, collIncrease, 0, debtIncrease, true, alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      const actualNewICR = await troveManager.getCurrentICR(alice, collaterals[0].address, price)
      assert.isTrue(actualNewICR.gt(CCR))
    })

    it("adjustTrove(): A trove with ICR > CCR in Recovery Mode can improve their ICR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      const CCR = await contracts.collateralConfig.getCollateralCCR(collaterals[0].address)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(115, 18)) // trigger drop in ETH price
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const initialICR = await troveManager.getCurrentICR(alice, collaterals[0].address, price)
      // Check initial ICR is above 165%
      assert.isTrue(initialICR.gt(CCR))

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      const debtIncrease = toBN(dec(5000, 18))
      const collIncrease = toBN(dec(150, collDecimals))

      const newICR = await troveManager.computeICR(aliceColl.add(collIncrease), aliceDebt.add(debtIncrease), price, collDecimals)

      // Check new ICR would be > old ICR
      assert.isTrue(newICR.gt(initialICR))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, collIncrease)
      const tx = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, collIncrease, 0, debtIncrease, true, alice, alice, { from: alice })
      assert.isTrue(tx.receipt.status)

      const actualNewICR = await troveManager.getCurrentICR(alice, collaterals[0].address, price)
      assert.isTrue(actualNewICR.gt(initialICR))
    })

    it("adjustTrove(): debt increase in Recovery Mode charges no fee", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(200000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await priceFeed.setPrice(collaterals[0].address, dec(120, 18)) // trigger drop in ETH price

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // B stakes LQTY
      await stakingToken.mint(bob, dec(100, 18))
      await stakingToken.approve(lqtyStaking.address, dec(100, 18), { from: bob })
      await lqtyStaking.stake(dec(100, 18), { from: bob })

      const lqtyStakingLUSDBalanceBefore = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStakingLUSDBalanceBefore.gt(toBN('0')))

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(100, collDecimals))
      const txAlice = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(100, collDecimals), 0, dec(50, 18), true, alice, alice, { from: alice })
      assert.isTrue(txAlice.receipt.status)

      // Check emitted fee = 0
      const emittedFee = toBN(await th.getEventArgByName(txAlice, 'LUSDBorrowingFeePaid', '_LUSDFee'))
      assert.isTrue(emittedFee.eq(toBN('0')))

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Check no fee was sent to staking contract
      const lqtyStakingLUSDBalanceAfter = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStakingLUSDBalanceAfter.toString(), lqtyStakingLUSDBalanceBefore.toString())
    })

    it("adjustTrove(): reverts when change would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(165, 16)), extraParams: { from: bob } })

      // Check TCR and Recovery Mode
      const TCR = (await th.getTCR(contracts, collaterals[0].address)).toString()
      assert.equal(TCR, '1650000000000000000')
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Bob attempts an operation that would bring the TCR below the CCR
      try {
        const txBob = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): reverts when LUSD repaid is > debt of the trove", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const bobOpenTx = (await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })).tx

      const bobDebt = await getTroveEntireDebt(bob, collaterals[0].address)
      assert.isTrue(bobDebt.gt(toBN('0')))

      const bobFee = toBN(await th.getEventArgByIndex(bobOpenTx, 'LUSDBorrowingFeePaid', 2))
      assert.isTrue(bobFee.gt(toBN('0')))

      // Alice transfers LUSD to bob to compensate borrowing fees
      await lusdToken.transfer(bob, bobFee, { from: alice })

      const remainingDebt = (await troveManager.getTroveDebt(bob, collaterals[0].address)).sub(LUSD_GAS_COMPENSATION)

      // Bob attempts an adjustment that would repay 1 wei more than his debt
      await assertRevert(
        borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, remainingDebt.add(toBN(1)), false, bob, bob, { from: bob }),
        "revert"
      )
    })

    it("adjustTrove(): reverts when attempted collateral withdrawal is >= the trove's collateral", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolColl = await getTroveEntireColl(carol, collaterals[0].address)

      // Carol attempts an adjustment that would withdraw 1 wei more than her collateral
      try {
        const txCarol = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, carolColl.add(toBN(1)), 0, true, carol, carol, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): reverts when change would cause the ICR of the trove to fall below the MCR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(12, 17)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(12, 17)), extraParams: { from: bob } })

      // Bob attempts to increase debt by 100 LUSD and 1 ether, i.e. a change that constitutes a 100% ratio of coll:debt.
      // Since his ICR prior is 110%, this change would reduce his ICR below MCR.
      try {
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, dec(1, collDecimals))
        const txBob = await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(100, 18), true, bob, bob, { from: bob })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("adjustTrove(): With 0 coll change, doesnt change borrower's coll or ActivePool coll", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)
      const activePoolCollBefore = await activePool.getCollateral(collaterals[0].address)

      assert.isTrue(aliceCollBefore.gt(toBN('0')))
      assert.isTrue(aliceCollBefore.eq(activePoolCollBefore))

      // Alice adjusts trove. No coll change, and a debt increase (+50LUSD)
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(50, 18), true, alice, alice, { from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)
      const activePoolCollAfter = await activePool.getCollateral(collaterals[0].address)

      assert.isTrue(aliceCollAfter.eq(activePoolCollAfter))
      assert.isTrue(activePoolCollAfter.eq(activePoolCollAfter))
    })

    it("adjustTrove(): With 0 debt change, doesnt change borrower's debt or ActivePool debt", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const activePoolDebtBefore = await activePool.getLUSDDebt(collaterals[0].address)

      assert.isTrue(aliceDebtBefore.gt(toBN('0')))
      assert.isTrue(aliceDebtBefore.eq(activePoolDebtBefore))

      // Alice adjusts trove. Coll change, no debt change
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, 0, false, alice, alice, { from: alice })

      const aliceDebtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const activePoolDebtAfter = await activePool.getLUSDDebt(collaterals[0].address)

      assert.isTrue(aliceDebtAfter.eq(aliceDebtBefore))
      assert.isTrue(activePoolDebtAfter.eq(activePoolDebtBefore))
    })

    it("adjustTrove(): updates borrower's debt and coll with an increase in both", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const collBefore = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      // Alice adjusts trove. Coll and debt increase(+1 ETH, +50LUSD)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, await getNetBorrowingAmount(dec(50, 18)), true, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const collAfter = await getTroveEntireColl(alice, collaterals[0].address)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(50, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(1, collDecimals))), 10000)
    })

    it("adjustTrove(): updates borrower's debt and coll with a decrease in both", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const collBefore = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      // Alice adjusts trove coll and debt decrease (-0.5 ETH, -50LUSD)
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(5, 11), dec(50, 18), false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const collAfter = await getTroveEntireColl(alice, collaterals[0].address)

      assert.isTrue(debtAfter.eq(debtBefore.sub(toBN(dec(50, 18)))))
      assert.isTrue(collAfter.eq(collBefore.sub(toBN(dec(5, 11)))))
    })

    it("adjustTrove(): updates borrower's  debt and coll with coll increase, debt decrease", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const collBefore = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt decrease (+5 ETH, -50LUSD)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(5, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(5, collDecimals), 0, dec(50, 18), false, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const collAfter = await getTroveEntireColl(alice, collaterals[0].address)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.sub(toBN(dec(50, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.add(toBN(dec(5, collDecimals))), 10000)
    })

    it("adjustTrove(): updates borrower's debt and coll with coll decrease, debt increase", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const debtBefore = await getTroveEntireDebt(alice, collaterals[0].address)
      const collBefore = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(debtBefore.gt(toBN('0')))
      assert.isTrue(collBefore.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt increase (1 ETH, 10LUSD)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(1, collDecimals), await getNetBorrowingAmount(dec(1, 18)), true, alice, alice, { from: alice })

      const debtAfter = await getTroveEntireDebt(alice, collaterals[0].address)
      const collAfter = await getTroveEntireColl(alice, collaterals[0].address)

      th.assertIsApproximatelyEqual(debtAfter, debtBefore.add(toBN(dec(1, 18))), 10000)
      th.assertIsApproximatelyEqual(collAfter, collBefore.sub(toBN(dec(1, collDecimals))), 10000)
    })

    it("adjustTrove(): updates borrower's stake and totalStakes with a coll increase", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const stakeBefore = await troveManager.getTroveStake(alice, collaterals[0].address)
      const totalStakesBefore = await troveManager.totalStakes(collaterals[0].address);
      assert.isTrue(stakeBefore.gt(toBN('0')))
      assert.isTrue(totalStakesBefore.gt(toBN('0')))

      // Alice adjusts trove - coll and debt increase (+1 ETH, +50 LUSD)
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(50, 18), true, alice, alice, { from: alice })

      const stakeAfter = await troveManager.getTroveStake(alice, collaterals[0].address)
      const totalStakesAfter = await troveManager.totalStakes(collaterals[0].address);

      assert.isTrue(stakeAfter.eq(stakeBefore.add(toBN(dec(1, collDecimals)))))
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.add(toBN(dec(1, collDecimals)))))
    })

    it("adjustTrove(): updates borrower's stake and totalStakes with a coll decrease", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const stakeBefore = await troveManager.getTroveStake(alice, collaterals[0].address)
      const totalStakesBefore = await troveManager.totalStakes(collaterals[0].address);
      assert.isTrue(stakeBefore.gt(toBN('0')))
      assert.isTrue(totalStakesBefore.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(5, 11), dec(50, 18), false, alice, alice, { from: alice })

      const stakeAfter = await troveManager.getTroveStake(alice, collaterals[0].address)
      const totalStakesAfter = await troveManager.totalStakes(collaterals[0].address);

      assert.isTrue(stakeAfter.eq(stakeBefore.sub(toBN(dec(5, 11)))))
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(toBN(dec(5, 11)))))
    })

    it("adjustTrove(): changes LUSDToken balance by the requested decrease", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(1, 11), dec(10, 18), false, alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.sub(toBN(dec(10, 18)))))
    })

    it("adjustTrove(): changes LUSDToken balance by the requested increase", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(100, 18), true, alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDTokenBalance_After.eq(alice_LUSDTokenBalance_Before.add(toBN(dec(100, 18)))))
    })

    it("adjustTrove(): Changes the activePool collateral balance by the requested decrease", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activePool_Coll_Before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_Before = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_Before.gt(toBN('0')))
      assert.isTrue(activePool_RawColl_Before.gt(toBN('0')))

      // Alice adjusts trove - coll decrease and debt decrease
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, dec(1, 11), dec(10, 18), false, alice, alice, { from: alice })

      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(activePool_Coll_Before.sub(toBN(dec(1, 11)))))
      assert.isTrue(activePool_RawColl_After.eq(activePool_Coll_Before.sub(toBN(dec(1, 11)))))
    })

    it("adjustTrove(): Changes the activePool collateral balance by the amount of collateral sent", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activePool_Coll_Before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_Before = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_Before.gt(toBN('0')))
      assert.isTrue(activePool_RawColl_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(100, 18), true, alice, alice, { from: alice })

      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawEther_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(activePool_Coll_Before.add(toBN(dec(1, collDecimals)))))
      assert.isTrue(activePool_RawEther_After.eq(activePool_Coll_Before.add(toBN(dec(1, collDecimals)))))
    })

    it("adjustTrove(): Changes the LUSD debt in ActivePool by requested decrease", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activePool_LUSDDebt_Before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSDDebt_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt decrease
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, dec(30, 18), false, alice, alice, { from: alice })

      const activePool_LUSDDebt_After = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSDDebt_After.eq(activePool_LUSDDebt_Before.sub(toBN(dec(30, 18)))))
    })

    it("adjustTrove(): Changes the LUSD debt in ActivePool by requested increase", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const activePool_LUSDDebt_Before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSDDebt_Before.gt(toBN('0')))

      // Alice adjusts trove - coll increase and debt increase
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(1, collDecimals))
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(1, collDecimals), 0, await getNetBorrowingAmount(dec(100, 18)), true, alice, alice, { from: alice })

      const activePool_LUSDDebt_After = await activePool.getLUSDDebt(collaterals[0].address)
    
      th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, activePool_LUSDDebt_Before.add(toBN(dec(100, 18))))
    })

    it("adjustTrove(): new coll = 0 and new debt = 0 is not allowed, as gas compensation still counts toward ICR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceDebt = await getTroveEntireColl(alice, collaterals[0].address)
      const status_Before = await troveManager.getTroveStatus(alice, collaterals[0].address)
      const isInSortedList_Before = await sortedTroves.contains(collaterals[0].address, alice)

      assert.equal(status_Before, 1)  // 1: Active
      assert.isTrue(isInSortedList_Before)

      await assertRevert(
        borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, aliceColl, aliceDebt, true, alice, alice, { from: alice }),
        'BorrowerOps: An operation that would result in ICR < MCR is not permitted'
      )
    })

    it("adjustTrove(): Reverts if requested debt increase and amount is zero", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, 0, true, alice, alice, { from: alice }),
        'BorrowerOps: Debt increase requires non-zero debtChange')
    })

    it("adjustTrove(): Reverts if requested coll withdrawal and ether is sent", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(3, collDecimals))
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, dec(3, collDecimals), dec(1, collDecimals), dec(100, 18), true, alice, alice, { from: alice }), 'BorrowerOperations: Cannot withdraw and add coll')
    })

    it("adjustTrove(): Reverts if it’s zero adjustment", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, 0, false, alice, alice, { from: alice }),
                         'BorrowerOps: There must be either a collateral change or a debt change')
    })

    it("adjustTrove(): Reverts if requested coll withdrawal is greater than trove's collateral", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })

      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)

      // Requested coll withdrawal > coll in the trove
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, aliceColl.add(toBN(1)), 0, false, alice, alice, { from: alice }))
      await assertRevert(borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, aliceColl.add(toBN(dec(37, collDecimals))), 0, false, bob, bob, { from: bob }))
    })

    it("adjustTrove(): Reverts if borrower has insufficient LUSD balance to cover his debt repayment", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: B } })
      const bobDebt = await getTroveEntireDebt(B, collaterals[0].address)

      // Bob transfers some LUSD to carol
      await lusdToken.transfer(C, dec(10, 18), { from: B })

      //Confirm B's LUSD balance is less than 50 LUSD
      const B_LUSDBal = await lusdToken.balanceOf(B)
      assert.isTrue(B_LUSDBal.lt(bobDebt))

      const repayLUSDPromise_B = borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, bobDebt, false, B, B, { from: B })

      // B attempts to repay all his debt
      await assertRevert(repayLUSDPromise_B, "revert")
    })

    // --- Internal _adjustTrove() ---

    if (!withProxy) { // no need to test this with proxies
      it("Internal _adjustTrove(): reverts when op is a withdrawal and _borrower param is not the msg.sender", async () => {
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const txPromise_A = borrowerOperations.callInternalAdjustLoan(alice, collaterals[0].address, 0, dec(1, collDecimals), dec(1, 18), true, alice, alice, { from: bob })
        await assertRevert(txPromise_A, "BorrowerOps: Caller must be the borrower for a withdrawal")
        const txPromise_B = borrowerOperations.callInternalAdjustLoan(bob, collaterals[0].address, 0, dec(1, collDecimals), dec(1, 18), true, alice, alice, { from: owner })
        await assertRevert(txPromise_B, "BorrowerOps: Caller must be the borrower for a withdrawal")
        const txPromise_C = borrowerOperations.callInternalAdjustLoan(carol, collaterals[0].address, 0, dec(1, collDecimals), dec(1, 18), true, alice, alice, { from: bob })
        await assertRevert(txPromise_C, "BorrowerOps: Caller must be the borrower for a withdrawal")
      })
    }

    // --- closeTrove() ---

    it("closeTrove(): reverts when it would lower the TCR below CCR", async () => {
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(300, 16)), extraParams:{ from: alice } })
      await openTrove({ collateral: collaterals[0], ICR: toBN(dec(160, 16)), extraLUSDAmount: toBN(dec(300, 18)), extraParams:{ from: bob } })

      const price = await priceFeed.getPrice(collaterals[0].address)
      
      // to compensate borrowing fees
      await lusdToken.transfer(alice, dec(300, 18), { from: bob })

      assert.isFalse(await troveManager.checkRecoveryMode(collaterals[0].address, price))
    
      await assertRevert(
        borrowerOperations.closeTrove(collaterals[0].address, { from: alice }),
        "BorrowerOps: An operation that would result in TCR < CCR is not permitted"
      )
    })

    it("closeTrove(): reverts when calling address does not have active trove", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: bob } })

      // Carol with no active trove attempts to close her trove
      try {
        const txCarol = await borrowerOperations.closeTrove(collaterals[0].address, { from: carol })
        assert.isFalse(txCarol.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("closeTrove(): reverts when system is in Recovery Mode", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Alice transfers her LUSD to Bob and Carol so they can cover fees
      const aliceBal = await lusdToken.balanceOf(alice)
      await lusdToken.transfer(bob, aliceBal.div(toBN(2)), { from: alice })
      await lusdToken.transfer(carol, aliceBal.div(toBN(2)), { from: alice })

      // check Recovery Mode 
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Bob successfully closes his trove
      const txBob = await borrowerOperations.closeTrove(collaterals[0].address, { from: bob })
      assert.isTrue(txBob.receipt.status)

      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Carol attempts to close her trove during Recovery Mode
      await assertRevert(borrowerOperations.closeTrove(collaterals[0].address, { from: carol }), "BorrowerOps: Operation not permitted during Recovery Mode")
    })

    it("closeTrove(): reverts when trove is the only one in the system", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(100000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Artificially mint to Alice so she has enough to close her trove
      await lusdToken.unprotectedMint(alice, dec(100000, 18))

      // Check she has more LUSD than her trove debt
      const aliceBal = await lusdToken.balanceOf(alice)
      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceBal.gt(aliceDebt))

      // check Recovery Mode
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Alice attempts to close her trove
      await assertRevert(borrowerOperations.closeTrove(collaterals[0].address, { from: alice }), "TroveManager: Only one trove in the system")
    })

    it("closeTrove(): reduces a Trove's collateral to zero", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceCollBefore = await getTroveEntireColl(alice, collaterals[0].address)
      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceCollBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)
      assert.equal(aliceCollAfter, '0')
    })

    it("closeTrove(): reduces a Trove's debt to zero", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebtBefore = await getTroveEntireColl(alice, collaterals[0].address)
      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceDebtBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)
      assert.equal(aliceCollAfter, '0')
    })

    it("closeTrove(): sets Trove's stake to zero", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceStakeBefore = await getTroveStake(alice, collaterals[0].address)
      assert.isTrue(aliceStakeBefore.gt(toBN('0')))

      const dennisLUSD = await lusdToken.balanceOf(dennis)
      assert.isTrue(aliceStakeBefore.gt(toBN('0')))
      assert.isTrue(dennisLUSD.gt(toBN('0')))

      // To compensate borrowing fees
      await lusdToken.transfer(alice, dennisLUSD.div(toBN(2)), { from: dennis })

      // Alice attempts to close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      const stakeAfter = ((await troveManager.Troves(alice, collaterals[0].address))[2]).toString()
      assert.equal(stakeAfter, '0')
      // check withdrawal was successful
    })

    it("closeTrove(): zero's the troves reward snapshots", async () => {
      // Dennis opens trove and transfers tokens to alice
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Price drops
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      // Liquidate Bob
      await troveManager.liquidate(bob, collaterals[0].address)
      assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

      // Price bounces back
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))

      // Alice and Carol open troves
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Price drops ...again
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      // Get Alice's pending reward snapshots 
      const L_Coll_A_Snapshot = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[0]
      const L_LUSDDebt_A_Snapshot = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[1]
      assert.isTrue(L_Coll_A_Snapshot.gt(toBN('0')))
      assert.isTrue(L_LUSDDebt_A_Snapshot.gt(toBN('0')))

      // Liquidate Carol
      await troveManager.liquidate(carol, collaterals[0].address)
      assert.isFalse(await sortedTroves.contains(collaterals[0].address, carol))

      // Get Alice's pending reward snapshots after Carol's liquidation. Check above 0
      const L_Coll_Snapshot_A_AfterLiquidation = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[0]
      const L_LUSDDebt_Snapshot_A_AfterLiquidation = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[1]

      assert.isTrue(L_Coll_Snapshot_A_AfterLiquidation.gt(toBN('0')))
      assert.isTrue(L_LUSDDebt_Snapshot_A_AfterLiquidation.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))

      // Alice closes trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // Check Alice's pending reward snapshots are zero
      const L_Coll_Snapshot_A_afterAliceCloses = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[0]
      const L_LUSDDebt_Snapshot_A_afterAliceCloses = (await troveManager.rewardSnapshots(alice, collaterals[0].address))[1]

      assert.equal(L_Coll_Snapshot_A_afterAliceCloses, '0')
      assert.equal(L_LUSDDebt_Snapshot_A_afterAliceCloses, '0')
    })

    it("closeTrove(): sets trove's status to closed and removes it from sorted troves list", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is active
      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const status_Before = alice_Trove_Before[3]

      assert.equal(status_Before, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const status_After = alice_Trove_After[3]

      assert.equal(status_After, 2)
      assert.isFalse(await sortedTroves.contains(collaterals[0].address, alice))
    })

    it("closeTrove(): reduces ActivePool collateral by correct amount", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const dennisColl = await getTroveEntireColl(dennis, collaterals[0].address)
      const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
      assert.isTrue(dennisColl.gt('0'))
      assert.isTrue(aliceColl.gt('0'))

      // Check active Pool ETH before
      const activePool_Coll_before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_before = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_before.eq(aliceColl.add(dennisColl)))
      assert.isTrue(activePool_Coll_before.gt(toBN('0')))
      assert.isTrue(activePool_RawColl_before.eq(activePool_Coll_before))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // Check after
      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(dennisColl))
      assert.isTrue(activePool_RawColl_After.eq(dennisColl))
    })

    it("closeTrove(): reduces ActivePool debt by correct amount", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const dennisDebt = await getTroveEntireDebt(dennis, collaterals[0].address)
      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(dennisDebt.gt('0'))
      assert.isTrue(aliceDebt.gt('0'))

      // Check before
      const activePool_Debt_before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_Debt_before.eq(aliceDebt.add(dennisDebt)))
      assert.isTrue(activePool_Debt_before.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Close the trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // Check after
      const activePool_Debt_After = (await activePool.getLUSDDebt(collaterals[0].address)).toString()
      th.assertIsApproximatelyEqual(activePool_Debt_After, dennisDebt)
    })

    it("closeTrove(): updates the total stakes", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Get individual stakes
      const aliceStakeBefore = await getTroveStake(alice, collaterals[0].address)
      const bobStakeBefore = await getTroveStake(bob, collaterals[0].address)
      const dennisStakeBefore = await getTroveStake(dennis, collaterals[0].address)
      assert.isTrue(aliceStakeBefore.gt('0'))
      assert.isTrue(bobStakeBefore.gt('0'))
      assert.isTrue(dennisStakeBefore.gt('0'))

      const totalStakesBefore = await troveManager.totalStakes(collaterals[0].address)

      assert.isTrue(totalStakesBefore.eq(aliceStakeBefore.add(bobStakeBefore).add(dennisStakeBefore)))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      // Alice closes trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // Check stake and total stakes get updated
      const aliceStakeAfter = await getTroveStake(alice, collaterals[0].address)
      const totalStakesAfter = await troveManager.totalStakes(collaterals[0].address)

      assert.equal(aliceStakeAfter, 0)
      assert.isTrue(totalStakesAfter.eq(totalStakesBefore.sub(aliceStakeBefore)))
    })

    if (!withProxy) { // TODO: wrap web3.eth.getBalance to be able to go through proxies
      it("closeTrove(): sends the correct amount of collateral to the user", async () => {
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        const aliceColl = await getTroveEntireColl(alice, collaterals[0].address)
        assert.isTrue(aliceColl.gt(toBN('0')))

        const alice_collBalance_Before = await collaterals[0].balanceOf(alice)

        // to compensate borrowing fees
        await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

        await borrowerOperations.closeTrove(collaterals[0].address, { from: alice, gasPrice: 0 })

        const alice_collBalance_After = await collaterals[0].balanceOf(alice)
        const balanceDiff = alice_collBalance_After.sub(alice_collBalance_Before)

        assert.isTrue(balanceDiff.eq(aliceColl))
      })
    }

    it("closeTrove(): subtracts the debt of the closed Trove from the Borrower's LUSDToken balance", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      const alice_LUSDBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDBalance_Before.gt(toBN('0')))

      // close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // check alice LUSD balance after
      const alice_LUSDBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDBalance_After, alice_LUSDBalance_Before.sub(aliceDebt.sub(LUSD_GAS_COMPENSATION)))
    })

    it("closeTrove(): applies pending rewards", async () => {
      // --- SETUP ---
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(1000000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      const whaleDebt = await getTroveEntireDebt(whale, collaterals[0].address)
      const whaleColl = await getTroveEntireColl(whale, collaterals[0].address)

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      const carolDebt = await getTroveEntireDebt(carol, collaterals[0].address)
      const carolColl = await getTroveEntireColl(carol, collaterals[0].address)

      // Whale transfers to A and B to cover their fees
      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await lusdToken.transfer(bob, dec(10000, 18), { from: whale })

      // --- TEST ---

      // price drops to 1ETH:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18));
      const price = await priceFeed.getPrice(collaterals[0].address)

      // liquidate Carol's Trove, Alice and Bob earn rewards.
      const liquidationTx = await troveManager.liquidate(carol, collaterals[0].address, { from: owner });
      const [liquidatedDebt_C, liquidatedColl_C, gasComp_C] = th.getEmittedLiquidationValues(liquidationTx)

      // Dennis opens a new Trove 
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // check Alice and Bob's reward snapshots are zero before they alter their Troves
      const alice_rewardSnapshot_Before = await troveManager.rewardSnapshots(alice, collaterals[0].address)
      const alice_CollrewardSnapshot_Before = alice_rewardSnapshot_Before[0]
      const alice_LUSDDebtRewardSnapshot_Before = alice_rewardSnapshot_Before[1]

      const bob_rewardSnapshot_Before = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollrewardSnapshot_Before = bob_rewardSnapshot_Before[0]
      const bob_LUSDDebtRewardSnapshot_Before = bob_rewardSnapshot_Before[1]

      assert.equal(alice_CollrewardSnapshot_Before, 0)
      assert.equal(alice_LUSDDebtRewardSnapshot_Before, 0)
      assert.equal(bob_CollrewardSnapshot_Before, 0)
      assert.equal(bob_LUSDDebtRewardSnapshot_Before, 0)

      const defaultPool_Coll = await defaultPool.getCollateral(collaterals[0].address)
      const defaultPool_LUSDDebt = await defaultPool.getLUSDDebt(collaterals[0].address)

      // Carol's liquidated coll (1 ETH) and drawn debt should have entered the Default Pool
      assert.isAtMost(th.getDifference(defaultPool_Coll, liquidatedColl_C), 100)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt, liquidatedDebt_C), 100)

      const pendingCollReward_A = await troveManager.getPendingCollateralReward(alice, collaterals[0].address)
      const pendingDebtReward_A = await troveManager.getPendingLUSDDebtReward(alice, collaterals[0].address)
      assert.isTrue(pendingCollReward_A.gt('0'))
      assert.isTrue(pendingDebtReward_A.gt('0'))

      // Close Alice's trove. Alice's pending rewards should be removed from the DefaultPool when she close.
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      const defaultPool_Coll_afterAliceCloses = await defaultPool.getCollateral(collaterals[0].address)
      const defaultPool_LUSDDebt_afterAliceCloses = await defaultPool.getLUSDDebt(collaterals[0].address)

      assert.isAtMost(th.getDifference(defaultPool_Coll_afterAliceCloses,
        defaultPool_Coll.sub(pendingCollReward_A)), 1000)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt_afterAliceCloses,
        defaultPool_LUSDDebt.sub(pendingDebtReward_A)), 1000)

      // whale adjusts trove, pulling their rewards out of DefaultPool
      await borrowerOperations.adjustTrove(collaterals[0].address, th._100pct, 0, 0, dec(1, 18), true, whale, whale, { from: whale })

      // Close Bob's trove. Expect DefaultPool coll and debt to drop to 0, since closing pulls his rewards out.
      await borrowerOperations.closeTrove(collaterals[0].address, { from: bob })

      const defaultPool_Coll_afterBobCloses = await defaultPool.getCollateral(collaterals[0].address)
      const defaultPool_LUSDDebt_afterBobCloses = await defaultPool.getLUSDDebt(collaterals[0].address)

      assert.isAtMost(th.getDifference(defaultPool_Coll_afterBobCloses, 0), 100000)
      assert.isAtMost(th.getDifference(defaultPool_LUSDDebt_afterBobCloses, 0), 100000)
    })

    it("closeTrove(): reverts if borrower has insufficient LUSD balance to repay his entire debt", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })

      //Confirm Bob's LUSD balance is less than his trove debt
      const B_LUSDBal = await lusdToken.balanceOf(B)
      const B_troveDebt = await getTroveEntireDebt(B, collaterals[0].address)

      assert.isTrue(B_LUSDBal.lt(B_troveDebt))

      const closeTrovePromise_B = borrowerOperations.closeTrove(collaterals[0].address, { from: B })

      // Check closing trove reverts
      await assertRevert(closeTrovePromise_B, "BorrowerOps: Caller doesnt have enough LUSD to make repayment")
    })

    it("closeTrove(): allowed when minting is paused", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      const alice_LUSDBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDBalance_Before.gt(toBN('0')))

      // close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // check alice LUSD balance after
      const alice_LUSDBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDBalance_After, alice_LUSDBalance_Before.sub(aliceDebt.sub(LUSD_GAS_COMPENSATION)))
    })

    it("closeTrove(): allowed even when protocol has been upgraded", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: dennis } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      // to compensate borrowing fees
      await lusdToken.transfer(alice, await lusdToken.balanceOf(dennis), { from: dennis })

      const alice_LUSDBalance_Before = await lusdToken.balanceOf(alice)
      assert.isTrue(alice_LUSDBalance_Before.gt(toBN('0')))

      // close trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // check alice LUSD balance after
      const alice_LUSDBalance_After = await lusdToken.balanceOf(alice)
      th.assertIsApproximatelyEqual(alice_LUSDBalance_After, alice_LUSDBalance_Before.sub(aliceDebt.sub(LUSD_GAS_COMPENSATION)))
    })

    // --- openTrove() ---

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("openTrove(): emits a TroveUpdated event with the correct collateral and debt", async () => {
        const txA = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(15000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })).tx
        const txB = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })).tx
        const txC = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })).tx

        const A_Coll = await getTroveEntireColl(A, collaterals[0].address)
        const B_Coll = await getTroveEntireColl(B, collaterals[0].address)
        const C_Coll = await getTroveEntireColl(C, collaterals[0].address)
        const A_Debt = await getTroveEntireDebt(A, collaterals[0].address)
        const B_Debt = await getTroveEntireDebt(B, collaterals[0].address)
        const C_Debt = await getTroveEntireDebt(C, collaterals[0].address)

        const A_emittedDebt = toBN(th.getEventArgByName(txA, "TroveUpdated", "_debt"))
        const A_emittedColl = toBN(th.getEventArgByName(txA, "TroveUpdated", "_coll"))
        const B_emittedDebt = toBN(th.getEventArgByName(txB, "TroveUpdated", "_debt"))
        const B_emittedColl = toBN(th.getEventArgByName(txB, "TroveUpdated", "_coll"))
        const C_emittedDebt = toBN(th.getEventArgByName(txC, "TroveUpdated", "_debt"))
        const C_emittedColl = toBN(th.getEventArgByName(txC, "TroveUpdated", "_coll"))

        // Check emitted debt values are correct
        assert.isTrue(A_Debt.eq(A_emittedDebt))
        assert.isTrue(B_Debt.eq(B_emittedDebt))
        assert.isTrue(C_Debt.eq(C_emittedDebt))

        // Check emitted coll values are correct
        assert.isTrue(A_Coll.eq(A_emittedColl))
        assert.isTrue(B_Coll.eq(B_emittedColl))
        assert.isTrue(C_Coll.eq(C_emittedColl))

        const baseRateBefore = await troveManager.baseRate()

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16))
        await troveManager.setLastFeeOpTimeToNow()

        assert.isTrue((await troveManager.baseRate()).gt(baseRateBefore))

        const txD = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })).tx
        const txE = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(3000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })).tx
        const D_Coll = await getTroveEntireColl(D, collaterals[0].address)
        const E_Coll = await getTroveEntireColl(E, collaterals[0].address)
        const D_Debt = await getTroveEntireDebt(D, collaterals[0].address)
        const E_Debt = await getTroveEntireDebt(E, collaterals[0].address)

        const D_emittedDebt = toBN(th.getEventArgByName(txD, "TroveUpdated", "_debt"))
        const D_emittedColl = toBN(th.getEventArgByName(txD, "TroveUpdated", "_coll"))

        const E_emittedDebt = toBN(th.getEventArgByName(txE, "TroveUpdated", "_debt"))
        const E_emittedColl = toBN(th.getEventArgByName(txE, "TroveUpdated", "_coll"))

        // Check emitted debt values are correct
        assert.isTrue(D_Debt.eq(D_emittedDebt))
        assert.isTrue(E_Debt.eq(E_emittedDebt))

        // Check emitted coll values are correct
        assert.isTrue(D_Coll.eq(D_emittedColl))
        assert.isTrue(E_Coll.eq(E_emittedColl))
      })
    }

    it("openTrove(): Opens a trove with net debt >= minimum net debt", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(100, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], C, dec(100, 30))

      // Add 1 wei to correct for rounding error in helper function
      const txA = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(1))), A, A, { from: A })
      assert.isTrue(txA.receipt.status)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, A))

      const txC = await borrowerOperations.openTrove(collaterals[0].address, dec(100, 30), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT.add(toBN(dec(47789898, 22)))), A, A, { from: C })
      assert.isTrue(txC.receipt.status)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, C))
    })

    it("openTrove(): reverts if net debt < minimum net debt", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(100, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], B, dec(100, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], C, dec(100, collDecimals))

      const txAPromise = borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, 0, A, A, { from: A })
      await assertRevert(txAPromise, "revert")

      const txBPromise = borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT.sub(toBN(1))), B, B, { from: B })
      await assertRevert(txBPromise, "revert")

      const txCPromise = borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, MIN_NET_DEBT.sub(toBN(dec(73, 18))), C, C, { from: C })
      await assertRevert(txCPromise, "revert")
    })

    it("openTrove(): decays a non-zero base rate", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate has decreased
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(12, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const baseRate_3 = await troveManager.baseRate()
      assert.isTrue(baseRate_3.lt(baseRate_2))
    })

    it("openTrove(): doesn't change base rate if it is already zero", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check baseRate is still 0
      const baseRate_2 = await troveManager.baseRate()
      assert.equal(baseRate_2, '0')

      // 1 hour passes
      th.fastForwardTime(3600, web3.currentProvider)

      // E opens trove 
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(12, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const baseRate_3 = await troveManager.baseRate()
      assert.equal(baseRate_3, '0')
    })

    it("openTrove(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      const lastFeeOpTime_1 = await troveManager.lastFeeOperationTime()

      // Borrower D triggers a fee
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      const lastFeeOpTime_2 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time did not update, as borrower D's debt issuance occured
      // since before minimum interval had passed 
      assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

      // 1 minute passes
      th.fastForwardTime(60, web3.currentProvider)

      // Check that now, at least one minute has passed since lastFeeOpTime_1
      const timeNow = await th.getLatestBlockTimestamp(web3)
      assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600))

      // Borrower E triggers a fee
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      const lastFeeOpTime_3 = await troveManager.lastFeeOperationTime()

      // Check that the last fee operation time DID update, as borrower's debt issuance occured
      // after minimum interval had passed 
      assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
    })

    it("openTrove(): reverts if max fee > 100%", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(3000, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], B, dec(3000, collDecimals))
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), dec(2, 18), dec(10000, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), '1000000000000000001', dec(20000, 18), B, B, { from: B }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("openTrove(): reverts if max fee < 0.5% in Normal mode", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(3000, collDecimals))
      await mintCollateralAndApproveBorrowerOps(collaterals[0], B, dec(3000, collDecimals))
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1200, collDecimals), 0, dec(195000, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), 1, dec(195000, 18), A, A, { from: A }), "Max fee percentage must be between 0.5% and 100%")
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1200, collDecimals), '4999999999999999', dec(195000, 18), B, B, { from: B }), "Max fee percentage must be between 0.5% and 100%")
    })

    it("openTrove(): allows max fee < 0.5% in Recovery Mode", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], A, dec(2000, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(2000, collDecimals), th._100pct, dec(195000, 18), A, A, { from: A })

      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], B, dec(3100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(3100, collDecimals), 0, dec(19500, 18), B, B, { from: B })
      await priceFeed.setPrice(collaterals[0].address, dec(50, 18))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], C, dec(3100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(3100, collDecimals), 1, dec(19500, 18), C, C, { from: C })
      await priceFeed.setPrice(collaterals[0].address, dec(25, 18))
      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      await mintCollateralAndApproveBorrowerOps(collaterals[0], D, dec(3100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(3100, collDecimals), '4999999999999999', dec(19500, 18), D, D, { from: D })
    })

    it("openTrove(): reverts if fee exceeds max fee percentage", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      const totalSupply = await lusdToken.totalSupply()

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      //       actual fee percentage: 0.005000000186264514
      // user's max fee percentage:  0.0049999999999999999
      let borrowingRate = await troveManager.getBorrowingRate() // expect max(0.5 + 5%, 5%) rate
      assert.equal(borrowingRate, dec(5, 16))

      const lessThan5pct = '49999999999999999'
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], D, dec(1000, collDecimals))
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), lessThan5pct, dec(30000, 18), A, A, { from: D }), "Fee exceeded provided maximum")

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))
      // Attempt with maxFee 1%
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), dec(1, 16), dec(30000, 18), A, A, { from: D }), "Fee exceeded provided maximum")

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))
      // Attempt with maxFee 3.754%
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), dec(3754, 13), dec(30000, 18), A, A, { from: D }), "Fee exceeded provided maximum")

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))
      // Attempt with maxFee 1e-16%
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1000, collDecimals), dec(5, 15), dec(30000, 18), A, A, { from: D }), "Fee exceeded provided maximum")
    })

    it("openTrove(): succeeds when fee is less than max fee percentage", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      let borrowingRate = await troveManager.getBorrowingRate() // expect min(0.5 + 5%, 5%) rate
      assert.equal(borrowingRate, dec(5, 16))

      // Attempt with maxFee > 5%
      const moreThan5pct = '50000000000000001'
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], D, dec(100, collDecimals))
      const tx1 = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), moreThan5pct, dec(10000, 18), A, A, { from: D })
      assert.isTrue(tx1.receipt.status)

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))

      // Attempt with maxFee = 5%
      await mintCollateralAndApproveBorrowerOps(collaterals[0], H, dec(100, collDecimals))
      const tx2 = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), dec(5, 16), dec(10000, 18), A, A, { from: H })
      assert.isTrue(tx2.receipt.status)

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))

      // Attempt with maxFee 10%
      await mintCollateralAndApproveBorrowerOps(collaterals[0], E, dec(100, collDecimals))
      const tx3 = await borrowerOperations.openTrove(collaterals[0].address,  dec(100, collDecimals), dec(1, 17), dec(10000, 18), A, A, { from: E })
      assert.isTrue(tx3.receipt.status)

      borrowingRate = await troveManager.getBorrowingRate() // expect 5% rate
      assert.equal(borrowingRate, dec(5, 16))

      // Attempt with maxFee 37.659%
      await mintCollateralAndApproveBorrowerOps(collaterals[0], F, dec(100, collDecimals))
      const tx4 = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), dec(37659, 13), dec(10000, 18), A, A, { from: F })
      assert.isTrue(tx4.receipt.status)

      // Attempt with maxFee 100%
      await mintCollateralAndApproveBorrowerOps(collaterals[0], G, dec(100, collDecimals))
      const tx5 = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), dec(1, 18), dec(10000, 18), A, A, { from: G })
      assert.isTrue(tx5.receipt.status)
    })

    it("openTrove(): borrower can't grief the baseRate and stop it decaying by issuing debt at higher frequency than the decay granularity", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 59 minutes pass
      th.fastForwardTime(3540, web3.currentProvider)

      // Assume Borrower also owns accounts D and E
      // Borrower triggers a fee, before decay interval has passed
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // 1 minute pass
      th.fastForwardTime(3540, web3.currentProvider)

      // Borrower triggers another fee
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(1, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })

      // Check base rate has decreased even though Borrower tried to stop it decaying
      const baseRate_2 = await troveManager.baseRate()
      assert.isTrue(baseRate_2.lt(baseRate_1))
    })

    it("openTrove(): borrowing at non-zero base rate sends LUSD fee to LQTY staking contract", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY LUSD balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY LUSD balance after has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))
    })

    if (!withProxy) { // TODO: use rawLogs instead of logs
      it("openTrove(): borrowing at non-zero base records the (drawn debt + fee  + liq. reserve) on the Trove struct", async () => {
        // time fast-forwards 1 year, and multisig stakes 1 LQTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
        await lqtyStaking.stake(dec(1, 18), { from: multisig })

        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
        await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

        // Artificially make baseRate 5%
        await troveManager.setBaseRate(dec(5, 16))
        await troveManager.setLastFeeOpTimeToNow()

        // Check baseRate is now non-zero
        const baseRate_1 = await troveManager.baseRate()
        assert.isTrue(baseRate_1.gt(toBN('0')))

        // 2 hours pass
        th.fastForwardTime(7200, web3.currentProvider)

        const D_LUSDRequest = toBN(dec(20000, 18))

        // D withdraws LUSD
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], D, dec(200, collDecimals))
        const openTroveTx = await borrowerOperations.openTrove(collaterals[0].address, dec(200, collDecimals), th._100pct, D_LUSDRequest, ZERO_ADDRESS, ZERO_ADDRESS, { from: D })

        const emittedFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(openTroveTx))
        assert.isTrue(toBN(emittedFee).gt(toBN('0')))

        const newDebt = (await troveManager.Troves(D, collaterals[0].address))[0]

        // Check debt on Trove struct equals drawn debt plus emitted fee
        th.assertIsApproximatelyEqual(newDebt, D_LUSDRequest.add(emittedFee).add(LUSD_GAS_COMPENSATION), 100000)
      })
    }

    it("openTrove(): Borrowing at non-zero base rate increases the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY contract LUSD fees-per-unit-staked is zero
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is now non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LQTY contract LUSD fees-per-unit-staked has increased
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt(F_LUSD_Before))
    })

    it("openTrove(): Borrowing at non-zero base rate sends requested amount to the user", async () => {
      // time fast-forwards 1 year, and multisig stakes 1 LQTY
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      await stakingToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
      await lqtyStaking.stake(dec(1, 18), { from: multisig })

      // Check LQTY Staking contract balance before == 0
      const lqtyStaking_LUSDBalance_Before = await lusdToken.balanceOf(lqtyStaking.address)
      assert.equal(lqtyStaking_LUSDBalance_Before, '0')

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Artificially make baseRate 5%
      await troveManager.setBaseRate(dec(5, 16))
      await troveManager.setLastFeeOpTimeToNow()

      // Check baseRate is non-zero
      const baseRate_1 = await troveManager.baseRate()
      assert.isTrue(baseRate_1.gt(toBN('0')))

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // D opens trove 
      const LUSDRequest_D = toBN(dec(40000, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], D, dec(500, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(500, collDecimals), th._100pct, LUSDRequest_D, D, D, { from: D })

      // Check LQTY staking LUSD balance has increased
      const lqtyStaking_LUSDBalance_After = await lusdToken.balanceOf(lqtyStaking.address)
      assert.isTrue(lqtyStaking_LUSDBalance_After.gt(lqtyStaking_LUSDBalance_Before))

      // Check D's LUSD balance now equals their requested LUSD
      const LUSDBalance_D = await lusdToken.balanceOf(D)
      assert.isTrue(LUSDRequest_D.eq(LUSDBalance_D))
    })

    it("openTrove(): Borrowing at zero base rate changes the LQTY staking contract LUSD fees-per-unit-staked", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

      // Check baseRate is zero
      const baseRate_1 = await troveManager.baseRate()
      assert.equal(baseRate_1, '0')

      // 2 hours pass
      th.fastForwardTime(7200, web3.currentProvider)

      // Check LUSD reward per LQTY staked == 0
      const F_LUSD_Before = await lqtyStaking.F_LUSD()
      assert.equal(F_LUSD_Before, '0')

      // A stakes LQTY
      await stakingToken.mint(A, dec(100, 18))
      await stakingToken.approve(lqtyStaking.address, dec(100, 18), { from: A })
      await lqtyStaking.stake(dec(100, 18), { from: A })

      // D opens trove 
      await openTrove({ collateral: collaterals[1], extraLUSDAmount: toBN(dec(37, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

      // Check LUSD reward per LQTY staked > 0
      const F_LUSD_After = await lqtyStaking.F_LUSD()
      assert.isTrue(F_LUSD_After.gt(toBN('0')))
    })

    it("openTrove(): Borrowing at zero base rate charges minimum fee", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })

      const LUSDRequest = toBN(dec(10000, 18))
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], C, dec(100, collDecimals))
      const txC = await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, LUSDRequest, ZERO_ADDRESS, ZERO_ADDRESS, { from: C })
      const _LUSDFee = toBN(th.getEventArgByName(txC, "LUSDBorrowingFeePaid", "_LUSDFee"))

      const expectedFee = BORROWING_FEE_FLOOR.mul(toBN(LUSDRequest)).div(toBN(dec(1, 18)))
      assert.isTrue(_LUSDFee.eq(expectedFee))
    })

    it("openTrove(): reverts when system is in Recovery Mode and ICR < CCR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(collaterals[0].address, dec(105, 18))

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Bob tries to open a trove with 149% ICR during Recovery Mode
      try {
        const txBob = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(149, 16)), extraParams: { from: alice } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts when trove ICR < MCR", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      assert.isFalse(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Bob attempts to open a 119% ICR trove in Normal Mode
      try {
        const txBob = (await openTrove({ collateral: collaterals[0],  extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(119, 16)), extraParams: { from: bob } })).tx
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }

      // price drops, and Recovery Mode kicks in
      await priceFeed.setPrice(collaterals[0].address, dec(105, 18))

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Bob attempts to open a 119% ICR trove in Recovery Mode
      try {
        const txBob = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(119, 16)), extraParams: { from: bob } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts when opening the trove would cause the TCR of the system to fall below the CCR", async () => {
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

      // Alice creates trove with 150% ICR.  System TCR = 150%.
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: alice } })

      const TCR = await th.getTCR(contracts, collaterals[0].address)
      assert.equal(TCR, dec(165, 16))

      // Bob attempts to open a trove with ICR = 164% 
      // System TCR would fall below 165%
      try {
        const txBob = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(164, 16)), extraParams: { from: bob } })
        assert.isFalse(txBob.receipt.status)
      } catch (err) {
        assert.include(err.message, "revert")
      }
    })

    it("openTrove(): reverts if trove is already active", async () => {
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(15, 17)), extraParams: { from: bob } })

      try {
        const txB_1 = await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(3, 18)), extraParams: { from: bob } })

        assert.isFalse(txB_1.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }

      try {
        const txB_2 = await openTrove({ collateral: collaterals[0], ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

        assert.isFalse(txB_2.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
      }

      // can open new trove with different collateral though
      await openTrove({ collateral: collaterals[1], ICR: toBN(dec(20, 18)), extraParams: { from: alice } })
    })

    it("openTrove(): Can open a trove with ICR >= CCR when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~165%
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: bob } })

      const TCR = (await th.getTCR(contracts, collaterals[0].address)).toString()
      assert.equal(TCR, '1650000000000000000')

      // price drops to 1ETH:100LUSD, reducing TCR below 165%
      await priceFeed.setPrice(collaterals[0].address, '100000000000000000000');
      const price = await priceFeed.getPrice(collaterals[0].address)

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      // Carol opens at 165% ICR in Recovery Mode
      const txCarol = (await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: carol } })).tx
      assert.isTrue(txCarol.receipt.status)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, carol))

      const carol_TroveStatus = await troveManager.getTroveStatus(carol, collaterals[0].address)
      assert.equal(carol_TroveStatus, 1)

      const carolICR = await troveManager.getCurrentICR(carol, collaterals[0].address, price)
      assert.isTrue(carolICR.gt(toBN(dec(165, 16))))
    })

    it("openTrove(): Reverts opening a trove with min debt when system is in Recovery Mode", async () => {
      // --- SETUP ---
      //  Alice and Bob add coll and withdraw such  that the TCR is ~165%
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: bob } })

      const TCR = (await th.getTCR(contracts, collaterals[0].address)).toString()
      assert.equal(TCR, '1650000000000000000')

      // price drops to 1ETH:100LUSD, reducing TCR below 150%
      await priceFeed.setPrice(collaterals[0].address, '100000000000000000000');

      assert.isTrue(await th.checkRecoveryMode(contracts, collaterals[0].address))

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], carol, dec(1, collDecimals))
      await assertRevert(borrowerOperations.openTrove(collaterals[0].address, dec(1, collDecimals), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT), carol, carol, { from: carol }))
    })

    it("openTrove(): creates a new Trove and assigns the correct collateral and debt amount", async () => {
      const debt_Before = await getTroveEntireDebt(alice, collaterals[0].address)
      const coll_Before = await getTroveEntireColl(alice, collaterals[0].address)
      const status_Before = await troveManager.getTroveStatus(alice, collaterals[0].address)

      // check coll and debt before
      assert.equal(debt_Before, 0)
      assert.equal(coll_Before, 0)

      // check non-existent status
      assert.equal(status_Before, 0)

      const LUSDRequest = MIN_NET_DEBT
      await priceFeed.setPrice(collaterals[0].address, dec(200, 18));
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, MIN_NET_DEBT, carol, carol, { from: alice })

      // Get the expected debt based on the LUSD request (adding fee and liq. reserve on top)
      const expectedDebt = LUSDRequest
        .add(await troveManager.getBorrowingFee(LUSDRequest))
        .add(LUSD_GAS_COMPENSATION)

      const debt_After = await getTroveEntireDebt(alice, collaterals[0].address)
      const coll_After = await getTroveEntireColl(alice, collaterals[0].address)
      const status_After = await troveManager.getTroveStatus(alice, collaterals[0].address)

      // check coll and debt after
      assert.isTrue(coll_After.gt('0'))
      assert.isTrue(debt_After.gt('0'))

      assert.isTrue(debt_After.eq(expectedDebt))

      // check active status
      assert.equal(status_After, 1)
    })

    it("openTrove(): adds Trove owner to TroveOwners array", async () => {
      const TroveOwnersCount_Before = (await troveManager.getTroveOwnersCount(collaterals[0].address)).toString();
      assert.equal(TroveOwnersCount_Before, '0')

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(165, 16)), extraParams: { from: alice } })

      const TroveOwnersCount_After = (await troveManager.getTroveOwnersCount(collaterals[0].address)).toString();
      assert.equal(TroveOwnersCount_After, '1')
    })

    it("openTrove(): creates a stake and adds it to total stakes", async () => {
      const aliceStakeBefore = await getTroveStake(alice, collaterals[0].address)
      const totalStakesBefore = await troveManager.totalStakes(collaterals[0].address)

      assert.equal(aliceStakeBefore, '0')
      assert.equal(totalStakesBefore, '0')

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)
      const aliceStakeAfter = await getTroveStake(alice, collaterals[0].address)
      assert.isTrue(aliceCollAfter.gt(toBN('0')))
      assert.isTrue(aliceStakeAfter.eq(aliceCollAfter))

      const totalStakesAfter = await troveManager.totalStakes(collaterals[0].address)

      assert.isTrue(totalStakesAfter.eq(aliceStakeAfter))
    })

    it("openTrove(): inserts Trove to Sorted Troves list", async () => {
      // Check before
      const aliceTroveInList_Before = await sortedTroves.contains(collaterals[0].address, alice)
      const listIsEmpty_Before = await sortedTroves.isEmpty(collaterals[0].address)
      assert.equal(aliceTroveInList_Before, false)
      assert.equal(listIsEmpty_Before, true)

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // check after
      const aliceTroveInList_After = await sortedTroves.contains(collaterals[0].address, alice)
      const listIsEmpty_After = await sortedTroves.isEmpty(collaterals[0].address)
      assert.equal(aliceTroveInList_After, true)
      assert.equal(listIsEmpty_After, false)
    })

    it("openTrove(): Increases the activePool collateral balance by correct amount", async () => {
      const activePool_Coll_Before = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_Before = await collaterals[0].balanceOf(activePool.address)
      assert.equal(activePool_Coll_Before, 0)
      assert.equal(activePool_RawColl_Before, 0)

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceCollAfter = await getTroveEntireColl(alice, collaterals[0].address)

      const activePool_Coll_After = await activePool.getCollateral(collaterals[0].address)
      const activePool_RawColl_After = await collaterals[0].balanceOf(activePool.address)
      assert.isTrue(activePool_Coll_After.eq(aliceCollAfter))
      assert.isTrue(activePool_RawColl_After.eq(aliceCollAfter))
    })

    it("openTrove(): records up-to-date initial snapshots of L_Collateral and L_LUSDDebt", async () => {
      // --- SETUP ---

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // --- TEST ---

      // price drops to 1ETH:100LUSD, reducing Carol's ICR below MCR
      await priceFeed.setPrice(collaterals[0].address, dec(100, 18));

      // close Carol's Trove, liquidating her 1 ether and 180LUSD.
      const liquidationTx = await troveManager.liquidate(carol, collaterals[0].address, { from: owner });
      const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

      /* with total stakes = 10 ether, after liquidation, L_ETH should equal 1/10 ether per-ether-staked,
       and L_LUSD should equal 18 LUSD per-ether-staked. */

      const L_Collateral = await troveManager.L_Collateral(collaterals[0].address)
      const L_LUSD = await troveManager.L_LUSDDebt(collaterals[0].address)

      assert.isTrue(L_Collateral.gt(toBN('0')))
      assert.isTrue(L_LUSD.gt(toBN('0')))

      // Bob opens trove
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: bob } })

      // Check Bob's snapshots of L_Collateral and L_LUSD equal the respective current values
      const bob_rewardSnapshot = await troveManager.rewardSnapshots(bob, collaterals[0].address)
      const bob_CollrewardSnapshot = bob_rewardSnapshot[0]
      const bob_LUSDDebtRewardSnapshot = bob_rewardSnapshot[1]

      assert.isAtMost(th.getDifference(bob_CollrewardSnapshot, L_Collateral), 1000)
      assert.isAtMost(th.getDifference(bob_LUSDDebtRewardSnapshot, L_LUSD), 1000)
    })

    it("openTrove(): allows a user to open a Trove, then close it, then re-open it", async () => {
      // Open Troves
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } })

      // Check Trove is active
      const alice_Trove_1 = await troveManager.Troves(alice, collaterals[0].address)
      const status_1 = alice_Trove_1[3]
      assert.equal(status_1, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))

      // to compensate borrowing fees
      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })

      // Repay and close Trove
      await borrowerOperations.closeTrove(collaterals[0].address, { from: alice })

      // Check Trove is closed
      const alice_Trove_2 = await troveManager.Troves(alice, collaterals[0].address)
      const status_2 = alice_Trove_2[3]
      assert.equal(status_2, 2)
      assert.isFalse(await sortedTroves.contains(collaterals[0].address, alice))

      // Re-open Trove
      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(5000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })

      // Check Trove is re-opened
      const alice_Trove_3 = await troveManager.Troves(alice, collaterals[0].address)
      const status_3 = alice_Trove_3[3]
      assert.equal(status_3, 1)
      assert.isTrue(await sortedTroves.contains(collaterals[0].address, alice))
    })

    it("openTrove(): increases the Trove's LUSD debt by the correct amount", async () => {
      // check before
      const alice_Trove_Before = await troveManager.Troves(alice, collaterals[0].address)
      const debt_Before = alice_Trove_Before[0]
      assert.equal(debt_Before, 0)

      await priceFeed.setPrice(collaterals[0].address, dec(200, 18));
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, await getOpenTroveLUSDAmount(dec(10000, 18)), alice, alice, { from: alice })

      // check after
      const alice_Trove_After = await troveManager.Troves(alice, collaterals[0].address)
      const debt_After = alice_Trove_After[0]
      th.assertIsApproximatelyEqual(debt_After, dec(10000, 18), 10000)
    })

    it("openTrove(): increases LUSD debt in ActivePool by the debt of the trove", async () => {
      const activePool_LUSDDebt_Before = await activePool.getLUSDDebt(collaterals[0].address)
      assert.equal(activePool_LUSDDebt_Before, 0)

      await openTrove({ collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
      const aliceDebt = await getTroveEntireDebt(alice, collaterals[0].address)
      assert.isTrue(aliceDebt.gt(toBN('0')))

      const activePool_LUSDDebt_After = await activePool.getLUSDDebt(collaterals[0].address)
      assert.isTrue(activePool_LUSDDebt_After.eq(aliceDebt))
    })

    it("openTrove(): increases user LUSDToken balance by correct amount", async () => {
      // check before
      const alice_LUSDTokenBalance_Before = await lusdToken.balanceOf(alice)
      assert.equal(alice_LUSDTokenBalance_Before, 0)

      await priceFeed.setPrice(collaterals[0].address, dec(200, 18));
      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, dec(100, collDecimals))
      await borrowerOperations.openTrove(collaterals[0].address, dec(100, collDecimals), th._100pct, dec(10000, 18), alice, alice, { from: alice })

      // check after
      const alice_LUSDTokenBalance_After = await lusdToken.balanceOf(alice)
      assert.equal(alice_LUSDTokenBalance_After, dec(10000, 18))
    })

    it("openTrove(): not allowed when minting is paused", async () => {
      await contracts.guardian.execute(lusdToken.address, 0, th.getTransactionData('pauseMinting()', []), 0, 100_000);

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], carol, dec(1, collDecimals))
      await assertRevert(
        borrowerOperations.openTrove(collaterals[0].address, dec(1, collDecimals), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT), carol, carol, { from: carol }),
        "LUSDToken: Minting is currently paused"
      );
    })

    it("openTrove(): not allowed when protocol has been upgraded", async () => {
      const newContracts = await deploymentHelper.deployLiquityCore();
      newContracts.troveManager = await TroveManagerTester.new()
      newContracts.lusdToken = lusdToken;
      newContracts.treasury = contracts.treasury;
      newContracts.collaterals = contracts.collaterals;
      newContracts.erc4626vaults = contracts.erc4626vaults;
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
      await deploymentHelper.connectLQTYContracts(LQTYContracts);
      await deploymentHelper.connectCoreContracts(newContracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, newContracts)
      await contracts.governance.execute(
        lusdToken.address,
        0,
        th.getTransactionData(
          'upgradeProtocol(address,address,address)',
          [
            newContracts.troveManager.address,
            newContracts.stabilityPool.address,
            newContracts.borrowerOperations.address
          ]
        ),
        0,
        300_000
      );

      const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
      await mintCollateralAndApproveBorrowerOps(collaterals[0], carol, dec(1, collDecimals))
      await assertRevert(
        borrowerOperations.openTrove(collaterals[0].address, dec(1, collDecimals), th._100pct, await getNetBorrowingAmount(MIN_NET_DEBT), carol, carol, { from: carol }),
        "LUSDToken: Minting is currently paused"
      );

      // can open trove in new version of protocol though
      // can open trove in new version as well
      await th.openTrove(
        newContracts,
        { collateral: collaterals[0], extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: carol } }
      );
    })

    //  --- getNewICRFromTroveChange - (external wrapper in Tester contract calls internal function) ---

    describe("getNewICRFromTroveChange() returns the correct ICR", async () => {


      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price, collDecimals)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price, collDecimals)).toString()
        assert.isAtMost(th.getDifference(newICR, '1333333333333333333'), 100)
      })

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = 0
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, false, price, collDecimals)).toString()
        assert.equal(newICR, '4000000000000000000')
      })

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        await priceFeed.setPrice(collaterals[1].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[1].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(1, collDecimals)
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price, collDecimals)).toString()
        assert.equal(newICR, '4000000000000000000')
      })

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 11)
        const debtChange = 0

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, true, price, collDecimals)).toString()
        assert.equal(newICR, '1000000000000000000')
      })

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 11)
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, false, price, collDecimals)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // +ve, +ve 
      it("collChange is positive, debtChange is positive", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(1, collDecimals)
        const debtChange = dec(100, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, true, price, collDecimals)).toString()
        assert.equal(newICR, '2000000000000000000')
      })

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(1, collDecimals)
        const debtChange = dec(50, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, true, debtChange, false, price, collDecimals)).toString()
        assert.equal(newICR, '8000000000000000000')
      })

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        price = await priceFeed.getPrice(collaterals[0].address)
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const initialColl = dec(1, collDecimals)
        const initialDebt = dec(100, 18)
        const collChange = dec(5, 11)
        const debtChange = dec(100, 18)

        const newICR = (await borrowerOperations.getNewICRFromTroveChange(initialColl, initialDebt, collChange, false, debtChange, true, price, collDecimals)).toString()
        assert.equal(newICR, '500000000000000000')
      })
    })

    // --- getCompositeDebt ---

    it("getCompositeDebt(): returns debt + gas comp", async () => {
      const res1 = await borrowerOperations.getCompositeDebt('0')
      assert.equal(res1, LUSD_GAS_COMPENSATION.toString())

      const res2 = await borrowerOperations.getCompositeDebt(dec(90, 18))
      th.assertIsApproximatelyEqual(res2, LUSD_GAS_COMPENSATION.add(toBN(dec(90, 18))))

      const res3 = await borrowerOperations.getCompositeDebt(dec(24423422357345049, 12))
      th.assertIsApproximatelyEqual(res3, LUSD_GAS_COMPENSATION.add(toBN(dec(24423422357345049, 12))))
    })

    //  --- getNewTCRFromTroveChange  - (external wrapper in Tester contract calls internal function) ---

    describe("getNewTCRFromTroveChange() returns the correct TCR", async () => {

      // 0, 0
      it("collChange = 0, debtChange = 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = 0
        const debtChange = 0
        const newTCR = await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, true, price)

        const expectedTCR = (troveColl.add(liquidatedColl).mul(toBN(10).pow(toBN(6)))).mul(price) // scale by 10^6 since WETH has 12 decimals in this test
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // 0, +ve
      it("collChange = 0, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = 0
        const debtChange = dec(200, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // 0, -ve
      it("collChange = 0, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)
        // --- TEST ---
        const collChange = 0
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, 0
      it("collChange is positive, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)
        // --- TEST ---
        const collChange = dec(2, collDecimals)
        const debtChange = 0
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(collChange)).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, 0
      it("collChange is negative, debtChange is 0", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = dec(1, collDecimals)
        const debtChange = 0
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, false, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(dec(1, collDecimals))).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, -ve
      it("collChange is negative, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = dec(1, collDecimals)
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, false, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(dec(1, collDecimals))).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, +ve 
      it("collChange is positive, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = dec(1, collDecimals)
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(dec(1, collDecimals))).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // +ve, -ve
      it("collChange is positive, debtChange is negative", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = dec(1, collDecimals)
        const debtChange = dec(100, 18)
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, true, debtChange, false, price))

        const expectedTCR = (troveColl.add(liquidatedColl).add(toBN(dec(1, collDecimals))).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).sub(toBN(dec(100, 18))))

        assert.isTrue(newTCR.eq(expectedTCR))
      })

      // -ve, +ve
      it("collChange is negative, debtChange is positive", async () => {
        // --- SETUP --- Create a Liquity instance with an Active Pool and pending rewards (Default Pool)
        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const collDecimals = await contracts.collateralConfig.getCollateralDecimals(collaterals[0].address)
        const troveColl = toBN(dec(1000, collDecimals))
        const troveTotalDebt = toBN(dec(100000, 18))
        const troveLUSDAmount = await getOpenTroveLUSDAmount(troveTotalDebt)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], alice, troveColl)
        await mintCollateralAndApproveBorrowerOps(collaterals[0], bob, troveColl)
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, alice, alice, { from: alice })
        await borrowerOperations.openTrove(collaterals[0].address, troveColl, th._100pct, troveLUSDAmount, bob, bob, { from: bob })

        await priceFeed.setPrice(collaterals[0].address, dec(100, 18))

        const liquidationTx = await troveManager.liquidate(bob, collaterals[0].address)
        assert.isFalse(await sortedTroves.contains(collaterals[0].address, bob))

        const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(liquidationTx)

        await priceFeed.setPrice(collaterals[0].address, dec(200, 18))
        const price = await priceFeed.getPrice(collaterals[0].address)

        // --- TEST ---
        const collChange = dec(1, collDecimals)
        const debtChange = await getNetBorrowingAmount(dec(200, 18))
        const newTCR = (await borrowerOperations.getNewTCRFromTroveChange(collaterals[0].address, collChange, false, debtChange, true, price))

        const expectedTCR = (troveColl.add(liquidatedColl).sub(toBN(collChange)).mul(toBN(10).pow(toBN(6)))).mul(price)
          .div(troveTotalDebt.add(liquidatedDebt).add(toBN(debtChange)))

        assert.isTrue(newTCR.eq(expectedTCR))
      })
    })
  }

  describe('Without proxy', async () => {
    testCorpus({ withProxy: false })
  })

  // describe('With proxy', async () => {
  //   testCorpus({ withProxy: true })
  // })
})

contract('Reset chain state', async accounts => { })

/* TODO:

 1) Test SortedList re-ordering by ICR. ICR ratio
 changes with addColl, withdrawColl, withdrawLUSD, repayLUSD, etc. Can split them up and put them with
 individual functions, or give ordering it's own 'describe' block.

 2)In security phase:
 -'Negative' tests for all the above functions.
 */
