# Cross Chain Vault

This repository has the smart contracts to enable cross-chain investment in an ERC-4626 vault that is on another
chain. It uses Chainlink's CCIP for sending messages and tokens cross-chain. Besides the flow of funds, it keeps up to date in the source chain the asset value of the investment, syncing the assets per share on every interaction (and triggered by an authorized user).

## Architecture

It's composed of two contracts, one (**ProxyVault**) deployed in the _source chain_ (where the source of funds and the withdrawals happen), and the other (**ProxyReceiver**) deployed in the _target chain_ (where the investment opportunity is).

These contracts are intended to be used by a single user. In the source chain there's always an accurate enough estimation of the total assets of the investment.

![cross-chain-vault](https://github.com/user-attachments/assets/fbd1ce03-f8d0-425a-beee-19c2ff724d9c)


### Deposits ### 

Deposits are sent to the other chain and immediatelly reflected in the `totalAssets()` method.

![cc-vault-enter](https://github.com/user-attachments/assets/b5f0a624-6d8e-44bc-a201-a9b786709903)

[Editable Sequence Diagram](https://sequencediagram.org/index.html#initialData=C4S2BsFMAIFEDtiQE4ChUBkAKBaAfAGoCGAruMFsgPYAeAngFwAmkADlQM5gAURHHkYBwCUqYmQrV6+AMIyAklgbQAxipCsAypHhNuLdl2AAaaMCoBrHQF4+AoaPHlKtOvieTXyjueSQsOkwg8ADmACJsnDwAtpD8RCGQ8kymdoIi6NbW8vBmABYwwETIicCqeUTBWahyivgu9ABKkCqQIABuKMpqGs2tHZD6kUam5lbwtvzpog10fW2dyO6k5MoGUcC8U0Kmfv2L1rPzA8gzUnMtCygAPDg4Ht4VfhyoR5cnsgpKqupagUOGMAAQRUFlMwTAICI4BwsXiiWSpg4TziqW2HACyE0KNMACNwFRQclRFkcvkYBwqCRkK1ypUJtYal9lhJZt1fsdOgCNiCwdAIaBobC4hwEkkUtBkcVUdA0kJMdjpXiCUSmI4Vp5pIQNWz+fAVH4+JBFc9uOrWecWc5zmsWoaBAFdMFwsMwBwzaggA)


### Withdrawals ### 

Withdrawals are asynchronous, they have to be requests and are processed in the destination chain. When the assets arrive to the source chain, they are transferred and a callback is called.

![cc-vault-exit](https://github.com/user-attachments/assets/583939ee-48e8-4f4e-bacc-6da6343fc3f1)
[Editable Sequence Diagram](https://sequencediagram.org/index.html#initialData=C4S2BsFMAIFEA8wCgkBkAKBaAfANQIYCu4w6ATgPbwCeAXAM4DGAFpACbGQDqYzbZ+AO75wACnz16kYPQA00YPjIBzafMYjwAI3yMA1gEokBYqUo0cAYUsBJdLWiNGIAA4BlSADs2owb35CIvISUjJGJiTkVNQ4EWbRDvTAFGSQ6F5sIJ7KPMB8AsJifnkBhTZswZLS9EZIALx1Np4KrApKqsCOzPhZDUjWdjhRNABKkIyQIABukGQOALaQkviqogBExfmB4GvyADybpSKYIGzYlaE1SMPUYxPTs7FEJA6HBeJVMvKp9zNkdTc7pM-kZAeNgbM9phMHFEt1UvRruZbuCHmQrLZ7I5nO4Mr5-AURJYKJ4AGYgMiLCoKCh6Lx1ELVfZvbYnM7yejwpYXarpMhuLnyLTgCj6cq1BoAIV0emgWRaMHoFEIZAmXR6nj6AyweGe8RoDicriBD3xJUJ4GJZIpVPkyTpmsZX2gBwJrNO52gnKU3OgTvofIFPqFIrFbHCepuT1MNwcbHGqQkkCDCNEEZjyOjkWRDmAAk89FJswAKhRRIoVNJ09nojgMLn2tIAHQacBiVvgaX6IxAA)

### Yield Sync ### 

![cc-vault-sync](https://github.com/user-attachments/assets/cf6d5a48-d657-4af8-9167-a506bcd025b9)

There's a primitive to synchronize from the target chain the assets per share, to reflect the yields obtained in the investment.

[Editable Sequence Diagram](https://sequencediagram.org/index.html#initialData=C4S2BsFMAIGUE8B2BjaBBAzhywPQAqQBOcAFgIZGQBQ1aAJgLYiIC0AfPkQPYAe8AJUjJIIAG7EAXNAxJkmbLkJFYFKgAoAlNS59Bw0RKIcAwiYCS+acmQgADrEiJ662SgU4My1ZUgAaaHIsT281f2gAI3BuZABrc3ptAF4k6AB5RGhgUhgMbgBXIhFoZAoWaBTqM0sOADVyfPBgXX5rWzshEXFIVzkPJWIfKgCgxS9BsIComPjE6nrG5p5+OoamlvhpfLt6cmBIABVuWKdxlTCtaiA)


### Access Controls ### 

The contracts are upgradeable contracts deployed behind a modified proxy, called AccessManagedProxy (see https://forum.openzeppelin.com/t/accessmanagedproxy-is-a-good-idea/41917), that provides out-of-the-box access control for all the methods, configurable using OpenZeppelin 5.x AccessManager contract. 

This simplifies the code of the contracts, making them more readable and leaving the access control logic in the configuration.
