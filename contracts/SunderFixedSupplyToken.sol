// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SunderFixedSupplyToken
/// @notice Minimal fixed-supply ERC-20 for direct self-custody deployment.
/// @dev No owner, mint, tax, blacklist, pause, or upgrade capability exists after construction.
contract SunderFixedSupplyToken {
    error InvalidMetadata();
    error InvalidRecipient();
    error InvalidSupply();
    error InsufficientAllowance();
    error InsufficientBalance();

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable totalSupply;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory tokenName,
        string memory tokenSymbol,
        uint8 tokenDecimals,
        uint256 tokenSupply,
        address recipient
    ) {
        bytes memory nameBytes = bytes(tokenName);
        bytes memory symbolBytes = bytes(tokenSymbol);
        if (nameBytes.length < 2 || nameBytes.length > 32 || symbolBytes.length < 2 || symbolBytes.length > 10) {
            revert InvalidMetadata();
        }
        if (tokenDecimals > 18) revert InvalidMetadata();
        if (recipient == address(0)) revert InvalidRecipient();
        if (tokenSupply == 0) revert InvalidSupply();

        name = tokenName;
        symbol = tokenSymbol;
        decimals = tokenDecimals;
        totalSupply = tokenSupply;
        balanceOf[recipient] = tokenSupply;
        emit Transfer(address(0), recipient, tokenSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            if (permitted < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = permitted - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidRecipient();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
