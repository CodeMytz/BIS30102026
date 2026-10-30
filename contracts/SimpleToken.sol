// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Plain ERC-20 used by the tests (same contract as in the group-token project).
contract SimpleToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply)
        ERC20(name_, symbol_)
    {
        _mint(msg.sender, supply);
    }
}
